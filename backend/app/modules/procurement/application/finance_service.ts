import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { costCenterFacts, legalEntityFacts } from '#modules/organization/index'
import { rateOn } from '#modules/settings/index'
import { postAccountingEvent } from '#modules/accounting/index'
import {
  money,
  parseScaled,
  scaledText,
  toFunctional,
} from '#modules/procurement/domain/requisitions'
import {
  ACCOUNTING_SOURCE,
  type ACCOUNTING_STATUSES,
  type AccountingLine,
  budgetState,
  documentAmounts,
  normalizeBudget,
  normalizePayment,
  orderCommitment,
  orderValueFor,
  PAYABLE_STATUSES,
  payableStatus,
  paymentAmounts,
  requisitionCommitment,
} from '#modules/procurement/domain/finance'

/*
 * Compras ↔ orçamento, obrigações a pagar e contabilidade (9.10).
 *
 *  - Compromissos: `syncCommitments` recalcula o valor em aberto de requisições e ordens e grava só a diferença no
 *    livro (só acréscimo); com controlo BLOCK, um aumento que passe a verba do centro de custo/ano é recusado
 *    (`BUDGET_EXCEEDED`). O realizado entra na validação de facturas e notas de crédito.
 *  - Obrigação a pagar: uma por factura validada (índice único), abatida pelas notas de crédito; pagamentos com
 *    `procurement.payables.pay` (tesouraria) — enquanto não houver módulo de Finanças/Tesouraria (Prompt 11), ficam
 *    aqui e publicam-se pelo contrato `procurementPayables`.
 *  - Contabilidade: um evento por factura, nota de crédito e pagamento (origem `PROCUREMENT`), enviado ao motor num
 *    savepoint; sem regra ou com erro fica FALHADO e repete-se (`retry`) sem bloquear o documento.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const c2 = (v: unknown) => {
  const s = String(v ?? '0')
  const neg = s.startsWith('-')
  const x = parseScaled(neg ? s.slice(1) : s, 2) ?? 0n
  return neg ? -x : x
}
const r10 = (v: unknown) =>
  v === null || v === undefined ? 10n ** 10n : (parseScaled(String(v), 10) ?? 10n ** 10n)
const today = () => new Date().toISOString().slice(0, 10)
const isoDate = (v: unknown) => {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v as Date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const yearOf = (v: unknown) => Number((isoDate(v) ?? today()).slice(0, 4))
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
const anyLe = (...ss: PermissionScope[]) =>
  ss.some((s) => s.tenant) ? 'ALL' : [...new Set(ss.flatMap((s) => [...s.legalEntityIds]))]

/* ------------------------------------------------------------------ compromissos */

interface Target {
  le: string
  cc: string | null
  year: number
  ref: string | null
  amount: bigint
  skip?: boolean
}

async function requisitionTarget(scope: TenantScope, id: string): Promise<Target> {
  const t = scope.context.tenantId
  const r = (
    await scope.trx.rawQuery(
      `select legal_entity_id, cost_center_id, status, exchange_rate, number, coalesce(approved_at, created_at) as at
         from purchase_requisitions where tenant_id = ? and id = ?`,
      [t, id]
    )
  ).rows[0] as any
  const lines = (
    await scope.trx.rawQuery(
      `select net_amount, quantity, ordered_quantity, closed_quantity from purchase_requisition_lines
        where tenant_id = ? and requisition_id = ?`,
      [t, id]
    )
  ).rows as any[]
  return {
    le: r.legal_entity_id,
    cc: r.cost_center_id ?? null,
    year: yearOf(r.at),
    ref: r.number ?? null,
    amount: requisitionCommitment(
      ['APPROVED', 'PARTIALLY_ORDERED'].includes(r.status),
      r10(r.exchange_rate),
      lines.map((l) => ({
        net: c2(l.net_amount),
        quantity: q6(l.quantity),
        ordered: q6(l.ordered_quantity),
        closed: q6(l.closed_quantity),
      }))
    ),
  }
}

async function orderTarget(scope: TenantScope, id: string): Promise<Target> {
  const t = scope.context.tenantId
  const o = (
    await scope.trx.rawQuery(
      `select legal_entity_id, cost_center_id, approval_status, issued_revision, revision, exchange_rate, number, order_date
         from purchase_orders where tenant_id = ? and id = ?`,
      [t, id]
    )
  ).rows[0] as any
  const lines = (
    await scope.trx.rawQuery(
      `select net_amount, quantity, cancelled_quantity, invoiced_quantity from purchase_order_lines
        where tenant_id = ? and order_id = ?`,
      [t, id]
    )
  ).rows as any[]
  const issued = o.issued_revision !== null
  // Em revisão, o compromisso fica o da versão emitida até à reemissão.
  const inRevision =
    issued && Number(o.issued_revision) !== Number(o.revision) && o.approval_status !== 'CANCELLED'
  return {
    le: o.legal_entity_id,
    cc: o.cost_center_id ?? null,
    year: yearOf(o.order_date),
    ref: o.number ?? null,
    skip: inRevision,
    amount: orderCommitment(
      issued && o.approval_status === 'APPROVED',
      r10(o.exchange_rate),
      lines.map((l) => ({
        net: c2(l.net_amount),
        quantity: q6(l.quantity),
        cancelled: q6(l.cancelled_quantity),
        invoiced: q6(l.invoiced_quantity),
      }))
    ),
  }
}

const budgetKey = (t: string, cc: string, year: number) => `budget:${t}:${cc}:${year}`

/** Comprometido e realizado de um centro de custo/ano (cêntimos). */
async function ccTotals(scope: TenantScope, cc: string, year: number) {
  const r = (
    await scope.trx.rawQuery(
      `select coalesce(sum(amount) filter (where kind = 'COMMITMENT'), 0)::text as c,
              coalesce(sum(amount) filter (where kind = 'COMMITMENT' and source_type = 'REQUISITION'), 0)::text as cr,
              coalesce(sum(amount) filter (where kind = 'ACTUAL'), 0)::text as a
         from procurement_commitments where tenant_id = ? and cost_center_id = ? and fiscal_year = ?`,
      [scope.context.tenantId, cc, year]
    )
  ).rows[0] as any
  return { committed: c2(r.c), requisitions: c2(r.cr), actual: c2(r.a) }
}

async function insertMovement(
  scope: TenantScope,
  m: {
    le: string
    cc: string
    year: number
    kind: 'COMMITMENT' | 'ACTUAL'
    sourceType: string
    sourceId: string
    ref: string | null
    amount: bigint
  }
) {
  await scope.trx.rawQuery(
    `insert into procurement_commitments (tenant_id, legal_entity_id, cost_center_id, fiscal_year, kind, source_type,
        source_id, source_ref, amount, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      m.le,
      m.cc,
      m.year,
      m.kind,
      m.sourceType,
      m.sourceId,
      m.ref?.slice(0, 60) ?? null,
      money(m.amount),
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

/**
 * Recalcula o compromisso em aberto de requisições e ordens e grava as diferenças. Com `check`, um centro de
 * custo/ano cujo comprometido aumentou e passou a verba com controlo BLOCK é recusado (a transacção desfaz-se).
 */
export async function syncCommitments(
  scope: TenantScope,
  docs: { requisitionIds?: string[]; orderIds?: string[] },
  opts: { check?: boolean } = {}
) {
  const t = scope.context.tenantId
  const delta = new Map<string, { le: string; cc: string; year: number; d: bigint }>()
  const work: [string, string][] = [
    ...[...new Set(docs.requisitionIds ?? [])].map((id) => ['REQUISITION', id] as [string, string]),
    ...[...new Set(docs.orderIds ?? [])].map((id) => ['ORDER', id] as [string, string]),
  ]
  for (const [type, id] of work) {
    const target =
      type === 'REQUISITION' ? await requisitionTarget(scope, id) : await orderTarget(scope, id)
    if (target.skip) continue
    // O que já está no livro deste documento, por centro de custo/ano (o centro de custo pode ter sido outro).
    const rows = (
      await scope.trx.rawQuery(
        `select cost_center_id, fiscal_year, legal_entity_id, sum(amount)::text as s from procurement_commitments
          where tenant_id = ? and source_type = ? and source_id = ? and kind = 'COMMITMENT'
          group by 1, 2, 3 having sum(amount) <> 0`,
        [t, type, id]
      )
    ).rows as any[]
    const wanted = new Map<string, { le: string; cc: string; year: number; amount: bigint }>()
    if (target.cc && target.amount !== 0n)
      wanted.set(`${target.cc}|${target.year}`, {
        le: target.le,
        cc: target.cc,
        year: target.year,
        amount: target.amount,
      })
    const keys = new Set([
      ...wanted.keys(),
      ...rows.map((x) => `${x.cost_center_id}|${x.fiscal_year}`),
    ])
    for (const k of keys) {
      const have = rows.find((x) => `${x.cost_center_id}|${x.fiscal_year}` === k)
      const want = wanted.get(k)
      const d = (want?.amount ?? 0n) - (have ? c2(have.s) : 0n)
      if (d === 0n) continue
      const [cc, year] = k.split('|')
      const le = want?.le ?? have.legal_entity_id
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        budgetKey(t, cc, Number(year)),
      ])
      await insertMovement(scope, {
        le,
        cc,
        year: Number(year),
        kind: 'COMMITMENT',
        sourceType: type,
        sourceId: id,
        ref: target.ref,
        amount: d,
      })
      const acc = delta.get(k) ?? { le, cc, year: Number(year), d: 0n }
      acc.d += d
      delta.set(k, acc)
    }
  }
  if (!opts.check) return
  for (const x of delta.values()) {
    if (x.d <= 0n) continue
    const b = (
      await scope.trx.rawQuery(
        `select amount, control from procurement_budgets where tenant_id = ? and cost_center_id = ? and fiscal_year = ?`,
        [t, x.cc, x.year]
      )
    ).rows[0] as any
    if (!b || b.control !== 'BLOCK') continue
    const totals = await ccTotals(scope, x.cc, x.year)
    const s = budgetState({
      amount: c2(b.amount),
      committed: totals.committed,
      actual: totals.actual,
    })
    if (s.over) {
      const cc = (await costCenterFacts(scope, [x.cc])).get(x.cc)
      throw new ApiError(
        409,
        'BUDGET_EXCEEDED',
        `Passa a verba de compras de ${x.year} do centro de custo ${cc?.code ?? ''} em ${money(-s.available)}.`,
        [
          { path: 'budget', code: 'BUDGET_EXCEEDED', message: money(-s.available) },
          { path: 'costCenterId', code: 'COST_CENTER', message: x.cc },
        ]
      )
    }
  }
}

/** Realizado (facturas e notas de crédito validadas) no centro de custo da ordem. */
async function recordActual(
  scope: TenantScope,
  a: {
    orderId: string
    sourceType: 'INVOICE' | 'CREDIT_NOTE'
    sourceId: string
    ref: string
    date: unknown
    net: bigint
  }
) {
  const o = (
    await scope.trx.rawQuery(
      `select legal_entity_id, cost_center_id from purchase_orders where tenant_id = ? and id = ?`,
      [scope.context.tenantId, a.orderId]
    )
  ).rows[0] as any
  if (!o?.cost_center_id || a.net === 0n) return
  await insertMovement(scope, {
    le: o.legal_entity_id,
    cc: o.cost_center_id,
    year: yearOf(a.date),
    kind: 'ACTUAL',
    sourceType: a.sourceType,
    sourceId: a.sourceId,
    ref: a.ref,
    amount: a.sourceType === 'INVOICE' ? a.net : -a.net,
  })
}

/* ------------------------------------------------------------------ contabilidade */

/** Linhas para a contabilização: líquido e imposto e, nos bens que entraram em stock, o valor da ordem. */
async function invoiceAccountingLines(
  scope: TenantScope,
  invoiceId: string
): Promise<AccountingLine[]> {
  const rows = (
    await scope.trx.rawQuery(
      `select l.net_amount, l.tax_amount, l.quantity, ol.net_amount as ol_net, ol.quantity as ol_qty,
          (p.product_type = 'STOCKABLE' and o.warehouse_id is not null) as stocked
         from purchase_invoice_lines l join purchase_invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
         join purchase_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
         left join purchase_order_lines ol on ol.tenant_id = l.tenant_id and ol.id = l.order_line_id
         left join products p on p.tenant_id = ol.tenant_id and p.id = ol.product_id
        where l.tenant_id = ? and l.invoice_id = ?`,
      [scope.context.tenantId, invoiceId]
    )
  ).rows as any[]
  return rows.map((x) => ({
    net: c2(x.net_amount),
    tax: c2(x.tax_amount),
    stockedOrderNet: x.stocked ? orderValueFor(c2(x.ol_net), q6(x.ol_qty), q6(x.quantity)) : null,
  }))
}

async function creditAccountingLines(
  scope: TenantScope,
  noteId: string
): Promise<AccountingLine[]> {
  const rows = (
    await scope.trx.rawQuery(
      `select x.kind, x.net_amount, x.tax_amount, x.quantity, ol.net_amount as ol_net, ol.quantity as ol_qty,
          (p.product_type = 'STOCKABLE' and o.warehouse_id is not null) as stocked
         from purchase_credit_note_lines x join purchase_credit_notes c on c.tenant_id = x.tenant_id and c.id = x.credit_note_id
         join purchase_orders o on o.tenant_id = c.tenant_id and o.id = c.order_id
         join purchase_invoice_lines il on il.tenant_id = x.tenant_id and il.id = x.invoice_line_id
         left join purchase_order_lines ol on ol.tenant_id = il.tenant_id and ol.id = il.order_line_id
         left join products p on p.tenant_id = ol.tenant_id and p.id = ol.product_id
        where x.tenant_id = ? and x.credit_note_id = ?`,
      [scope.context.tenantId, noteId]
    )
  ).rows as any[]
  return rows.map((x) => ({
    net: c2(x.net_amount),
    tax: c2(x.tax_amount),
    // Quantidade devolvida de um bem em stock: volta pelas recepções por facturar (a devolução já tirou o stock).
    // Ajuste de valor num bem em stock: é diferença de preço (nada a saldar nas recepções); sem stock: serviços.
    stockedOrderNet: !x.stocked
      ? null
      : x.kind === 'QUANTITY'
        ? orderValueFor(c2(x.ol_net), q6(x.ol_qty), q6(x.quantity))
        : 0n,
  }))
}

async function insertAccountingEvent(
  scope: TenantScope,
  e: {
    le: string
    documentType: 'INVOICE' | 'CREDIT_NOTE' | 'PAYMENT'
    documentId: string
    event: string
    ref: string
    occurredOn: string
    total: bigint
    amounts: Record<string, string>
    costCenterId: string | null
    thirdPartyRef: string | null
    key: string
  }
) {
  const r = await scope.trx.rawQuery(
    `insert into procurement_accounting_events (tenant_id, legal_entity_id, document_type, document_id, event, source_ref,
        occurred_on, total, amounts, cost_center_id, third_party_ref, idempotency_key, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
     on conflict (tenant_id, idempotency_key) do nothing returning id`,
    [
      scope.context.tenantId,
      e.le,
      e.documentType,
      e.documentId,
      e.event,
      e.ref.slice(0, 120),
      e.occurredOn,
      money(e.total),
      JSON.stringify(e.amounts),
      e.costCenterId,
      e.thirdPartyRef?.slice(0, 80) ?? null,
      e.key,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  return (r.rows[0] as { id: string } | undefined)?.id ?? null
}

/** Envia um evento ao motor num savepoint; falhar não desfaz o documento. */
async function send(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  const x = (
    await scope.trx.rawQuery(
      `select *, occurred_on::text as day from procurement_accounting_events where tenant_id = ? and id = ? for update`,
      [t, id]
    )
  ).rows[0] as any
  if (!x || x.status === 'POSTED' || x.status === 'DRAFTED') return x?.status as string
  await scope.trx.rawQuery('savepoint procurement_accounting')
  try {
    const res = await postAccountingEvent(scope, {
      legalEntityId: x.legal_entity_id,
      source: ACCOUNTING_SOURCE,
      event: x.event,
      sourceRef: x.source_ref,
      occurredOn: x.day,
      amounts: x.amounts,
      costCenterId: x.cost_center_id,
      thirdPartyRef: x.third_party_ref,
      description: `Compras ${x.event} ${x.source_ref}`,
      idempotencyKey: `proc:${x.idempotency_key}`,
    })
    await scope.trx.rawQuery('release savepoint procurement_accounting')
    const status = (res.event as any).status === 'POSTED' ? 'POSTED' : 'DRAFTED'
    await scope.trx.rawQuery(
      `update procurement_accounting_events set status = ?, posting_event_id = ?, error = null, attempts = attempts + 1,
          updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
      [status, (res.event as any).id, scope.context.userId, t, id] as never[]
    )
    return status
  } catch (error) {
    await scope.trx.rawQuery('rollback to savepoint procurement_accounting')
    const msg =
      error instanceof ApiError
        ? ((error.details?.[0] as any)?.message ?? error.message)
        : String((error as Error).message ?? error)
    await scope.trx.rawQuery(
      `update procurement_accounting_events set status = 'FAILED', error = ?, attempts = attempts + 1, updated_at = now(),
          updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
      [String(msg).slice(0, 500), scope.context.userId, t, id] as never[]
    )
    return 'FAILED'
  }
}

/* ------------------------------------------------------------------ contratos com facturas e notas de crédito */

/**
 * Factura validada: realizado no centro de custo, compromisso da ordem actualizado, **uma** obrigação a pagar e o
 * evento contabilístico `INVOICE`. Chamado na transacção da validação, depois de somado o facturado à ordem.
 */
export async function onInvoiceValidated(scope: TenantScope, invoiceId: string) {
  const t = scope.context.tenantId
  const i = (
    await scope.trx.rawQuery(
      `select i.*, o.exchange_rate as order_rate, o.cost_center_id, bp.code as sup_code
         from purchase_invoices i join purchase_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
         join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where i.tenant_id = ? and i.id = ?`,
      [t, invoiceId]
    )
  ).rows[0] as any
  const rate = r10(i.exchange_rate)
  await recordActual(scope, {
    orderId: i.order_id,
    sourceType: 'INVOICE',
    sourceId: i.id,
    ref: i.number,
    date: i.invoice_date,
    net: toFunctional(c2(i.total_net), rate),
  })
  await syncCommitments(scope, { orderIds: [i.order_id] })
  await scope.trx.rawQuery(
    `insert into procurement_payables (tenant_id, legal_entity_id, supplier_id, order_id, invoice_id, cost_center_id,
        currency, amount, exchange_rate, due_date, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t,
      i.legal_entity_id,
      i.supplier_id,
      i.order_id,
      i.id,
      i.cost_center_id,
      i.currency,
      money(c2(i.total_amount)),
      scaledText(rate, 10),
      isoDate(i.due_date),
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  const a = documentAmounts(await invoiceAccountingLines(scope, i.id), rate, r10(i.order_rate))
  const id = await insertAccountingEvent(scope, {
    le: i.legal_entity_id,
    documentType: 'INVOICE',
    documentId: i.id,
    event: 'INVOICE',
    ref: `${i.number} ${i.invoice_number}`,
    occurredOn: isoDate(i.invoice_date)!,
    total: a.total,
    amounts: a.amounts,
    costCenterId: i.cost_center_id,
    thirdPartyRef: i.sup_code,
    key: `invoice:${i.id}`,
  })
  if (id) await send(scope, id)
}

/** Nota de crédito validada: abate a obrigação, realizado negativo, compromisso da ordem e evento `CREDIT_NOTE`. */
export async function onCreditNoteValidated(scope: TenantScope, noteId: string) {
  const t = scope.context.tenantId
  const c = (
    await scope.trx.rawQuery(
      `select c.*, o.exchange_rate as order_rate, o.cost_center_id, bp.code as sup_code
         from purchase_credit_notes c join purchase_orders o on o.tenant_id = c.tenant_id and o.id = c.order_id
         join suppliers s on s.tenant_id = c.tenant_id and s.id = c.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where c.tenant_id = ? and c.id = ?`,
      [t, noteId]
    )
  ).rows[0] as any
  const rate = r10(c.exchange_rate)
  const p = (
    await scope.trx.rawQuery(
      `select * from procurement_payables where tenant_id = ? and invoice_id = ? for update`,
      [t, c.invoice_id]
    )
  ).rows[0] as any
  if (p) {
    const credited = c2(p.credited_amount) + c2(c.total_amount)
    const status = payableStatus({ amount: c2(p.amount), credited, paid: c2(p.paid_amount) })
    await scope.trx.rawQuery(
      `update procurement_payables set credited_amount = ?, status = ?, updated_by = ?, updated_at = now(),
          version = version + 1 where tenant_id = ? and id = ?`,
      [money(credited), status, scope.context.userId, t, p.id] as never[]
    )
  }
  await recordActual(scope, {
    orderId: c.order_id,
    sourceType: 'CREDIT_NOTE',
    sourceId: c.id,
    ref: c.number,
    date: c.credit_note_date,
    net: toFunctional(c2(c.total_net), rate),
  })
  await syncCommitments(scope, { orderIds: [c.order_id] })
  const a = documentAmounts(await creditAccountingLines(scope, c.id), rate, r10(c.order_rate))
  const id = await insertAccountingEvent(scope, {
    le: c.legal_entity_id,
    documentType: 'CREDIT_NOTE',
    documentId: c.id,
    event: 'CREDIT_NOTE',
    ref: `${c.number} ${c.credit_note_number}`,
    occurredOn: isoDate(c.credit_note_date)!,
    total: a.total,
    amounts: a.amounts,
    costCenterId: c.cost_center_id,
    thirdPartyRef: c.sup_code,
    key: `credit-note:${c.id}`,
  })
  if (id) await send(scope, id)
}

/* ------------------------------------------------------------------ serviços */

async function accountingOf(scope: TenantScope, docs: { type: string; id: string }[]) {
  if (!docs.length) return []
  const rows = (
    await scope.trx.rawQuery(
      `select e.*, pe.entry_id, je.number as entry_number from procurement_accounting_events e
         left join posting_events pe on pe.tenant_id = e.tenant_id and pe.id = e.posting_event_id
         left join journal_entries je on je.tenant_id = pe.tenant_id and je.id = pe.entry_id
        where e.tenant_id = ? and (e.document_type, e.document_id) in (${docs.map(() => '(?, ?::uuid)').join(', ')})
        order by e.created_at`,
      [scope.context.tenantId, ...docs.flatMap((d) => [d.type, d.id])] as never[]
    )
  ).rows as any[]
  return rows.map(eventView)
}

const eventView = (e: any) => ({
  id: e.id as string,
  documentType: e.document_type as string,
  documentId: e.document_id as string,
  event: e.event as string,
  sourceRef: e.source_ref as string,
  occurredOn: isoDate(e.occurred_on)!,
  total: money(c2(e.total)),
  amounts: e.amounts as Record<string, string>,
  status: e.status as (typeof ACCOUNTING_STATUSES)[number],
  error: (e.error as string) ?? null,
  attempts: Number(e.attempts),
  entryNumber: (e.entry_number as string) ?? null,
})

async function payableDetail(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  if (!isUuid(id)) throw ApiError.notFound()
  const p = (
    await scope.trx.rawQuery(
      `select p.*, i.number as invoice_internal, i.invoice_number, i.invoice_date, o.number as order_number,
          bp.code as sup_code, bp.name as sup_name, le.code as le_code, cc.code as cc_code
         from procurement_payables p join purchase_invoices i on i.tenant_id = p.tenant_id and i.id = p.invoice_id
         join purchase_orders o on o.tenant_id = p.tenant_id and o.id = p.order_id
         join suppliers s on s.tenant_id = p.tenant_id and s.id = p.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
         join legal_entities le on le.tenant_id = p.tenant_id and le.id = p.legal_entity_id
         left join cost_centers cc on cc.tenant_id = p.tenant_id and cc.id = p.cost_center_id
        where p.tenant_id = ? and p.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!p) throw ApiError.notFound()
  const read = await permissionScope(scope, 'procurement.payables.read')
  const pay = await permissionScope(scope, 'procurement.payables.pay')
  if (!covers(read, p.legal_entity_id) && !covers(pay, p.legal_entity_id)) throw ApiError.notFound()
  const payments = (
    await scope.trx.rawQuery(
      `select x.*, b.bank_name, b.currency as bank_currency, u.full_name from procurement_payments x
         left join bank_accounts b on b.tenant_id = x.tenant_id and b.id = x.bank_account_id
         left join users u on u.id = x.created_by
        where x.tenant_id = ? and x.payable_id = ? order by x.paid_on, x.created_at`,
      [t, id]
    )
  ).rows as any[]
  const notes = (
    await scope.trx.rawQuery(
      `select id from purchase_credit_notes where tenant_id = ? and invoice_id = ? and status = 'VALIDATED'`,
      [t, p.invoice_id]
    )
  ).rows as any[]
  const canPay = covers(pay, p.legal_entity_id) && p.status !== 'SETTLED'
  const banks = canPay
    ? ((
        await scope.trx.rawQuery(
          `select id, bank_name, holder_name, iban, account_number from bank_accounts where tenant_id = ?
              and legal_entity_id = ? and status = 'ACTIVE' and trim(currency) = ? order by is_default desc, bank_name`,
          [t, p.legal_entity_id, String(p.currency).trim()]
        )
      ).rows as any[])
    : []
  const balance = c2(p.amount) - c2(p.credited_amount) - c2(p.paid_amount)
  const due = isoDate(p.due_date)!
  return {
    id: p.id as string,
    version: Number(p.version),
    status: p.status as (typeof PAYABLE_STATUSES)[number],
    legalEntity: { id: p.legal_entity_id as string, code: p.le_code as string },
    supplier: {
      id: p.supplier_id as string,
      code: p.sup_code as string,
      name: p.sup_name as string,
    },
    order: { id: p.order_id as string, number: p.order_number as string },
    invoice: {
      id: p.invoice_id as string,
      number: p.invoice_internal as string,
      invoiceNumber: p.invoice_number as string,
      invoiceDate: isoDate(p.invoice_date)!,
    },
    costCenter: p.cost_center_id
      ? { id: p.cost_center_id as string, code: p.cc_code as string }
      : null,
    currency: String(p.currency).trim(),
    exchangeRate: scaledText(r10(p.exchange_rate), 10),
    amount: money(c2(p.amount)),
    creditedAmount: money(c2(p.credited_amount)),
    paidAmount: money(c2(p.paid_amount)),
    balance: money(balance),
    dueDate: due,
    overdue: balance > 0n && due < today(),
    payments: payments.map((x) => ({
      id: x.id as string,
      paidOn: isoDate(x.paid_on)!,
      amount: money(c2(x.amount)),
      exchangeRate: scaledText(r10(x.exchange_rate), 10),
      amountFunctional: money(c2(x.amount_functional)),
      reference: x.reference as string,
      notes: (x.notes as string) ?? null,
      bank: (x.bank_name as string) ?? null,
      by: (x.full_name as string) ?? null,
    })),
    bankAccounts: banks.map((b) => ({
      id: b.id as string,
      label: `${b.bank_name} — ${b.holder_name}${b.iban ? ' · …' + String(b.iban).slice(-4) : b.account_number ? ' · …' + String(b.account_number).slice(-4) : ''}`,
    })),
    accounting: await accountingOf(scope, [
      { type: 'INVOICE', id: p.invoice_id },
      ...notes.map((n) => ({ type: 'CREDIT_NOTE', id: n.id as string })),
      ...payments.map((x) => ({ type: 'PAYMENT', id: x.id as string })),
    ]),
    can: { pay: canPay, retry: covers(pay, p.legal_entity_id) },
  }
}

export type PayableDetail = Awaited<ReturnType<typeof payableDetail>>

export class PayableService {
  list(
    context: TenantContext,
    f: {
      status?: string
      supplierId?: string
      overdue?: boolean
      q?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const les = anyLe(
        await permissionScope(scope, 'procurement.payables.read'),
        await permissionScope(scope, 'procurement.payables.pay')
      )
      if (les !== 'ALL' && !les.length) return { items: [], total: 0 }
      const where = ['p.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (les !== 'ALL') {
        where.push('p.legal_entity_id = any(?::uuid[])')
        params.push(les)
      }
      if (f.status && (PAYABLE_STATUSES as readonly string[]).includes(f.status)) {
        where.push('p.status = ?')
        params.push(f.status)
      }
      if (f.supplierId && isUuid(f.supplierId)) {
        where.push('p.supplier_id = ?')
        params.push(f.supplierId)
      }
      if (f.overdue) where.push(`p.status <> 'SETTLED' and p.due_date < current_date`)
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(i.number) like ? or lower(i.invoice_number) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like)
      }
      const from = `from procurement_payables p join purchase_invoices i on i.tenant_id = p.tenant_id and i.id = p.invoice_id
        join suppliers s on s.tenant_id = p.tenant_id and s.id = p.supplier_id
        join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select p.*, i.number as invoice_internal, i.invoice_number, bp.code as sup_code, bp.name as sup_name ${from}
            order by p.due_date, p.created_at limit ? offset ?`,
          [...params, f.limit, f.offset] as never[]
        )
      ).rows as any[]
      const total = Number(
        (
          (await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[]))
            .rows[0] as any
        ).n
      )
      const now = today()
      return {
        items: rows.map((p) => {
          const balance = c2(p.amount) - c2(p.credited_amount) - c2(p.paid_amount)
          return {
            id: p.id as string,
            status: p.status as string,
            supplier: {
              id: p.supplier_id as string,
              code: p.sup_code as string,
              name: p.sup_name as string,
            },
            invoice: {
              id: p.invoice_id as string,
              number: p.invoice_internal as string,
              invoiceNumber: p.invoice_number as string,
            },
            currency: String(p.currency).trim(),
            amount: money(c2(p.amount)),
            balance: money(balance),
            dueDate: isoDate(p.due_date)!,
            overdue: balance > 0n && isoDate(p.due_date)! < now,
          }
        }),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => payableDetail(scope, id))
  }

  /** Registar um pagamento: com a obrigação bloqueada, nunca acima do saldo; evento `PAYMENT` à contabilidade. */
  pay(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      if (!isUuid(id)) throw ApiError.notFound()
      const p = (
        await scope.trx.rawQuery(
          `select * from procurement_payables where tenant_id = ? and id = ? for update`,
          [t, id]
        )
      ).rows[0] as any
      if (!p) throw ApiError.notFound()
      const read = await permissionScope(scope, 'procurement.payables.read')
      const pay = await permissionScope(scope, 'procurement.payables.pay')
      if (!covers(read, p.legal_entity_id) && !covers(pay, p.legal_entity_id))
        throw ApiError.notFound()
      if (!covers(pay, p.legal_entity_id))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista pagamentos desta entidade.')
      if (Number(p.version) !== Number(input.expectedVersion))
        throw ApiError.versionConflict(Number(p.version))
      const { payment, issues } = normalizePayment(input, today())
      const balance = c2(p.amount) - c2(p.credited_amount) - c2(p.paid_amount)
      if (!issues.length && payment.amount > balance)
        issues.push({
          path: 'amount',
          code: 'OVER_BALANCE',
          message: `O saldo em dívida é ${money(balance < 0n ? 0n : balance)}.`,
        })
      const currency = String(p.currency).trim()
      const bank = isUuid(input.bankAccountId)
        ? ((
            await scope.trx.rawQuery(
              `select legal_entity_id, currency, status, bank_name from bank_accounts where tenant_id = ? and id = ?`,
              [t, input.bankAccountId]
            )
          ).rows[0] as any)
        : null
      if (!bank || bank.legal_entity_id !== p.legal_entity_id || bank.status !== 'ACTIVE')
        issues.push({
          path: 'bankAccountId',
          code: 'INVALID',
          message: 'Conta bancária activa desta entidade legal.',
        })
      else if (String(bank.currency).trim() !== currency)
        issues.push({
          path: 'bankAccountId',
          code: 'CURRENCY_MISMATCH',
          message: `A conta tem de ser em ${currency}.`,
        })
      if (!issues.length) {
        const inv = (
          await scope.trx.rawQuery(
            `select invoice_date from purchase_invoices where tenant_id = ? and id = ?`,
            [t, p.invoice_id]
          )
        ).rows[0] as any
        if (payment.paidOn < isoDate(inv.invoice_date)!)
          issues.push({
            path: 'paidOn',
            code: 'BEFORE_INVOICE',
            message: 'O pagamento não pode ser anterior à factura.',
          })
      }
      fail(issues)
      const le = (await legalEntityFacts(scope, p.legal_entity_id))!
      let rate = 10n ** 10n
      if (currency !== le.functionalCurrency) {
        const fx = await rateOn(scope, currency, le.functionalCurrency, payment.paidOn)
        if (!fx)
          throw ApiError.conflict(
            'NO_RATE',
            `Sem câmbio ${currency}→${le.functionalCurrency} na data do pagamento: registe-o em Câmbios.`
          )
        rate = parseScaled(String(fx.rate), 10)!
      }
      const ins = await scope.trx.rawQuery(
        `insert into procurement_payments (tenant_id, payable_id, bank_account_id, paid_on, amount, exchange_rate,
            amount_functional, reference, notes, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         returning id`,
        [
          t,
          id,
          input.bankAccountId,
          payment.paidOn,
          money(payment.amount),
          scaledText(rate, 10),
          money(toFunctional(payment.amount, rate)),
          payment.reference,
          payment.notes,
          context.userId,
          context.userId,
        ] as never[]
      )
      const paymentId = (ins.rows[0] as { id: string }).id
      const paid = c2(p.paid_amount) + payment.amount
      const status = payableStatus({ amount: c2(p.amount), credited: c2(p.credited_amount), paid })
      await scope.trx.rawQuery(
        `update procurement_payables set paid_amount = ?, status = ?, updated_by = ?, updated_at = now(),
            version = version + 1 where tenant_id = ? and id = ?`,
        [money(paid), status, context.userId, t, id] as never[]
      )
      const sup = (
        await scope.trx.rawQuery(
          `select bp.code, i.number from purchase_invoices i join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id
             join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
            where i.tenant_id = ? and i.id = ?`,
          [t, p.invoice_id]
        )
      ).rows[0] as any
      const a = paymentAmounts(payment.amount, r10(p.exchange_rate), rate)
      const ev = await insertAccountingEvent(scope, {
        le: p.legal_entity_id,
        documentType: 'PAYMENT',
        documentId: paymentId,
        event: 'PAYMENT',
        ref: `${sup.number} ${payment.reference}`,
        occurredOn: payment.paidOn,
        total: a.total,
        amounts: a.amounts,
        costCenterId: p.cost_center_id,
        thirdPartyRef: sup.code,
        key: `payment:${paymentId}`,
      })
      if (ev) await send(scope, ev)
      await audit(scope, {
        action: 'procurement_payable.paid',
        entityType: 'procurement_payable',
        entityId: id,
        changes: {
          paidAmount: { from: money(c2(p.paid_amount)), to: money(paid) },
          status: { from: p.status, to: status },
        },
        metadata: { paymentId, reference: payment.reference },
      })
      return payableDetail(scope, id)
    })
  }

  /** Repetir os eventos contabilísticos falhados de uma obrigação (factura, notas de crédito, pagamentos). */
  retry(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const d = await payableDetail(scope, id)
      if (!d.can.retry)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não trata a contabilização desta entidade.')
      for (const e of d.accounting.filter((x) => x.status === 'FAILED' || x.status === 'PENDING'))
        await send(scope, e.id)
      await audit(scope, {
        action: 'procurement_payable.accounting_retried',
        entityType: 'procurement_payable',
        entityId: id,
      })
      return payableDetail(scope, id)
    })
  }
}

/* ------------------------------------------------------------------ orçamento */

async function budgetScopes(scope: TenantScope) {
  return {
    read: await permissionScope(scope, 'procurement.budgets.read'),
    manage: await permissionScope(scope, 'procurement.budgets.manage'),
  }
}

async function budgetView(scope: TenantScope, b: any) {
  const totals = await ccTotals(scope, b.cost_center_id, Number(b.fiscal_year))
  const s = budgetState({
    amount: c2(b.amount),
    committed: totals.committed,
    actual: totals.actual,
  })
  return {
    id: b.id as string,
    version: Number(b.version),
    legalEntity: { id: b.legal_entity_id as string, code: b.le_code as string },
    costCenter: {
      id: b.cost_center_id as string,
      code: b.cc_code as string,
      name: b.cc_name as string,
    },
    fiscalYear: Number(b.fiscal_year),
    amount: money(c2(b.amount)),
    control: b.control as string,
    notes: (b.notes as string) ?? null,
    committedRequisitions: money(totals.requisitions),
    committedOrders: money(totals.committed - totals.requisitions),
    actual: money(totals.actual),
    available: money(s.available),
    over: s.over,
  }
}

const BUDGET_SELECT = `select b.*, le.code as le_code, cc.code as cc_code, cc.name as cc_name from procurement_budgets b
  join legal_entities le on le.tenant_id = b.tenant_id and le.id = b.legal_entity_id
  join cost_centers cc on cc.tenant_id = b.tenant_id and cc.id = b.cost_center_id`

export class BudgetService {
  list(context: TenantContext, f: { fiscalYear?: number; legalEntityId?: string }) {
    return runInTenant(context, async (scope) => {
      const s = await budgetScopes(scope)
      const les = anyLe(s.read, s.manage)
      if (les !== 'ALL' && !les.length) return []
      const where = ['b.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (les !== 'ALL') {
        where.push('b.legal_entity_id = any(?::uuid[])')
        params.push(les)
      }
      if (f.fiscalYear) {
        where.push('b.fiscal_year = ?')
        params.push(f.fiscalYear)
      }
      if (f.legalEntityId && isUuid(f.legalEntityId)) {
        where.push('b.legal_entity_id = ?')
        params.push(f.legalEntityId)
      }
      const rows = (
        await scope.trx.rawQuery(
          `${BUDGET_SELECT} where ${where.join(' and ')} order by b.fiscal_year desc, cc.code`,
          params as never[]
        )
      ).rows as any[]
      const out = []
      for (const b of rows)
        out.push({
          ...(await budgetView(scope, b)),
          canManage: covers(s.manage, b.legal_entity_id),
        })
      return out
    })
  }

  /** Centros de custo activos das entidades em que o membro gere o orçamento (para o formulário). */
  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await budgetScopes(scope)
      const les = anyLe(s.manage)
      if (les !== 'ALL' && !les.length) return { costCenters: [] }
      const rows = (
        await scope.trx.rawQuery(
          `select cc.id, cc.code, cc.name, le.code as le_code from cost_centers cc
             join legal_entities le on le.tenant_id = cc.tenant_id and le.id = cc.legal_entity_id
            where cc.tenant_id = ? and cc.status = 'ACTIVE'${les === 'ALL' ? '' : ' and cc.legal_entity_id = any(?::uuid[])'}
            order by le.code, cc.code`,
          (les === 'ALL' ? [context.tenantId] : [context.tenantId, les]) as never[]
        )
      ).rows as any[]
      return {
        costCenters: rows.map((c) => ({
          id: c.id as string,
          code: c.code as string,
          name: c.name as string,
          legalEntity: c.le_code as string,
        })),
      }
    })
  }

  /** Movimentos do livro de um centro de custo/ano (para conferir de onde vem o comprometido). */
  movements(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(id)) throw ApiError.notFound()
      const b = (
        await scope.trx.rawQuery(`${BUDGET_SELECT} where b.tenant_id = ? and b.id = ?`, [
          context.tenantId,
          id,
        ])
      ).rows[0] as any
      const s = await budgetScopes(scope)
      if (!b || !(covers(s.read, b.legal_entity_id) || covers(s.manage, b.legal_entity_id)))
        throw ApiError.notFound()
      const rows = (
        await scope.trx.rawQuery(
          `select kind, source_type, source_id, source_ref, sum(amount)::text as amount, max(created_at) as at
             from procurement_commitments where tenant_id = ? and cost_center_id = ? and fiscal_year = ?
            group by 1, 2, 3, 4 having sum(amount) <> 0 order by max(created_at) desc limit 500`,
          [context.tenantId, b.cost_center_id, b.fiscal_year]
        )
      ).rows as any[]
      return {
        budget: await budgetView(scope, b),
        documents: rows.map((x) => ({
          kind: x.kind as string,
          sourceType: x.source_type as string,
          sourceId: x.source_id as string,
          sourceRef: (x.source_ref as string) ?? null,
          amount: money(c2(x.amount)),
        })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await budgetScopes(scope)
      const issues: ErrorDetail[] = []
      const ccId = isUuid(input.costCenterId) ? (input.costCenterId as string) : null
      const cc = ccId ? (await costCenterFacts(scope, [ccId])).get(ccId) : undefined
      // Inexistente (ou de outra empresa): 404, como os restantes registos.
      if (ccId && !cc) throw ApiError.notFound()
      if (!cc) issues.push({ path: 'costCenterId', code: 'REQUIRED', message: 'Centro de custo.' })
      const { budget, issues: more } = normalizeBudget(input)
      issues.push(...more)
      fail(issues)
      if (!covers(s.manage, cc!.legalEntityId))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere o orçamento desta entidade.')
      const exists = (
        await scope.trx.rawQuery(
          `select 1 from procurement_budgets where tenant_id = ? and cost_center_id = ? and fiscal_year = ?`,
          [context.tenantId, ccId, budget.fiscalYear] as never[]
        )
      ).rows.length
      if (exists)
        throw ApiError.conflict(
          'BUDGET_EXISTS',
          'Já há verba para este centro de custo neste ano: altere-a.'
        )
      let ins: { rows: unknown[] }
      try {
        ins = await scope.trx.rawQuery(
          `insert into procurement_budgets (tenant_id, legal_entity_id, cost_center_id, fiscal_year, amount, control, notes,
              created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            context.tenantId,
            cc!.legalEntityId,
            ccId,
            budget.fiscalYear,
            money(budget.amount),
            budget.control,
            budget.notes,
            context.userId,
            context.userId,
          ] as never[]
        )
      } catch (e: any) {
        // Duas verbas para o mesmo centro de custo e ano ao mesmo tempo: o índice único decide (409, nunca 500).
        if (
          e?.code === '23505' &&
          String(e?.constraint ?? e?.message).includes('procurement_budgets_unique')
        )
          throw ApiError.conflict(
            'BUDGET_EXISTS',
            'Já há verba para este centro de custo neste ano: altere-a.'
          )
        throw e
      }
      const id = (ins.rows[0] as { id: string }).id
      await audit(scope, {
        action: 'procurement_budget.created',
        entityType: 'procurement_budget',
        entityId: id,
        changes: {
          amount: { from: null, to: money(budget.amount) },
          control: { from: null, to: budget.control },
        },
      })
      const row = (
        await scope.trx.rawQuery(`${BUDGET_SELECT} where b.tenant_id = ? and b.id = ?`, [
          context.tenantId,
          id,
        ])
      ).rows[0]
      return { ...(await budgetView(scope, row)), canManage: true }
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(id)) throw ApiError.notFound()
      const b = (
        await scope.trx.rawQuery(
          `${BUDGET_SELECT} where b.tenant_id = ? and b.id = ? for update of b`,
          [context.tenantId, id]
        )
      ).rows[0] as any
      const s = await budgetScopes(scope)
      if (!b || !(covers(s.read, b.legal_entity_id) || covers(s.manage, b.legal_entity_id)))
        throw ApiError.notFound()
      if (!covers(s.manage, b.legal_entity_id))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere o orçamento desta entidade.')
      if (Number(b.version) !== Number(input.expectedVersion))
        throw ApiError.versionConflict(Number(b.version))
      const { budget, issues } = normalizeBudget({ ...input, fiscalYear: b.fiscal_year })
      fail(issues)
      await scope.trx.rawQuery(
        `update procurement_budgets set amount = ?, control = ?, notes = ?, updated_by = ?, updated_at = now(),
            version = version + 1 where tenant_id = ? and id = ?`,
        [
          money(budget.amount),
          budget.control,
          budget.notes,
          context.userId,
          context.tenantId,
          id,
        ] as never[]
      )
      await audit(scope, {
        action: 'procurement_budget.updated',
        entityType: 'procurement_budget',
        entityId: id,
        changes: {
          amount: { from: money(c2(b.amount)), to: money(budget.amount) },
          control: { from: b.control, to: budget.control },
        },
      })
      const row = (
        await scope.trx.rawQuery(`${BUDGET_SELECT} where b.tenant_id = ? and b.id = ?`, [
          context.tenantId,
          id,
        ])
      ).rows[0]
      return { ...(await budgetView(scope, row)), canManage: true }
    })
  }
}

/** Contrato para o futuro módulo de Finanças/Tesouraria: obrigações de compras de uma entidade com saldo. */
export async function procurementPayables(scope: TenantScope, legalEntityId: string) {
  const rows = (
    await scope.trx.rawQuery(
      `select p.id, p.invoice_id, p.supplier_id, p.currency, p.amount, p.credited_amount, p.paid_amount, p.due_date,
          p.status from procurement_payables p where p.tenant_id = ? and p.legal_entity_id = ? and p.status <> 'SETTLED'
        order by p.due_date`,
      [scope.context.tenantId, legalEntityId]
    )
  ).rows as any[]
  return rows.map((p) => ({
    id: p.id as string,
    invoiceId: p.invoice_id as string,
    supplierId: p.supplier_id as string,
    currency: String(p.currency).trim(),
    balance: money(c2(p.amount) - c2(p.credited_amount) - c2(p.paid_amount)),
    dueDate: isoDate(p.due_date)!,
    status: p.status as string,
  }))
}
