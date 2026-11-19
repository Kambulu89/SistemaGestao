import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts } from '#modules/organization/index'
import { rateOn, reserveDocumentNumber } from '#modules/settings/index'
import {
  money,
  parseScaled,
  scaledText,
  toFunctional,
} from '#modules/procurement/domain/requisitions'
import {
  invoiceStatus as orderInvoiceStatus,
  orderLineAmounts,
} from '#modules/procurement/domain/orders'
import {
  type Divergence,
  dueDate,
  INVOICE_SERIES_TYPE,
  INVOICE_STATUSES,
  type InvoiceStatus,
  invoiceNumberKey,
  isDate,
  matchLine,
  matchTotal,
  NO_TOLERANCE,
  normalizeInvoiceLines,
  normalizeTolerances,
  type Tolerances,
} from '#modules/procurement/domain/invoices'

/*
 * Facturas de fornecedor (9.8). Permissões no âmbito da entidade legal: `procurement.invoices.read`, `.manage`
 * (registar, validar, devolver ao fornecedor, anular) e `.approve` (autorizar ou recusar as excepções da conferência —
 * nunca quem pediu a validação). Tolerâncias com `procurement.settings`. A validação, com a ordem bloqueada, faz a
 * conferência a três com os números do momento e só então soma o facturado à ordem. A obrigação de pagamento e a
 * contabilização são do 9.10.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const c2 = (v: unknown) => parseScaled(String(v ?? '0'), 2) ?? 0n
const r3 = (v: unknown) => parseScaled(String(v ?? '0'), 3) ?? 0n
const r10 = (v: unknown) => parseScaled(String(v ?? '0'), 10) ?? 0n
const today = () => new Date().toISOString().slice(0, 10)
const isoDate = (v: unknown) => {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v as Date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface Scopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
}
async function scopesOf(scope: TenantScope): Promise<Scopes> {
  return {
    read: await permissionScope(scope, 'procurement.invoices.read'),
    manage: await permissionScope(scope, 'procurement.invoices.manage'),
    approve: await permissionScope(scope, 'procurement.invoices.approve'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
const rights = (s: Scopes, le: string) => {
  const manage = covers(s.manage, le)
  const approve = covers(s.approve, le)
  return { read: manage || approve || covers(s.read, le), manage, approve }
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const i = (
    await scope.trx.rawQuery(
      `select * from purchase_invoices where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!i) throw ApiError.notFound()
  return i
}

async function authorized(
  scope: TenantScope,
  id: string,
  need: 'read' | 'manage' | 'approve',
  lock = false
) {
  const i = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), i.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (need === 'manage' && !g.manage)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista facturas desta entidade.')
  if (need === 'approve' && !g.approve)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não autoriza excepções de facturas desta entidade.')
  return { i, g }
}

const versionCheck = (x: any, expected: unknown) => {
  if (Number(x.version) !== Number(expected)) throw ApiError.versionConflict(Number(x.version))
}
const reasonOf = (v: unknown) => {
  const r = text(v)
  if (!r) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r
}

async function event(
  scope: TenantScope,
  id: string,
  kind: string,
  e: { reason?: string | null; details?: Record<string, unknown> } = {}
) {
  await scope.trx.rawQuery(
    `insert into purchase_invoice_events (tenant_id, invoice_id, kind, reason, details, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      id,
      kind,
      e.reason ?? null,
      e.details ? JSON.stringify(e.details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function setInvoice(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update purchase_invoices set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/** Tolerâncias da empresa (sem configuração: zero). */
export async function tolerancesOf(scope: TenantScope): Promise<Tolerances> {
  const r = (
    await scope.trx.rawQuery(`select * from procurement_tolerances where tenant_id = ?`, [
      scope.context.tenantId,
    ])
  ).rows[0] as any
  if (!r) return NO_TOLERANCE
  return {
    pricePct: r3(r.price_pct),
    priceAmount: c2(r.price_amount),
    qtyPct: r3(r.qty_pct),
    totalAmount: c2(r.total_amount),
  }
}
const toleranceView = (t: Tolerances) => ({
  pricePct: scaledText(t.pricePct, 3),
  priceAmount: money(t.priceAmount),
  qtyPct: scaledText(t.qtyPct, 3),
  totalAmount: money(t.totalAmount),
})

async function loadOrder(scope: TenantScope, orderId: string, lock = false) {
  if (!isUuid(orderId)) fail([{ path: 'orderId', code: 'REQUIRED', message: 'Ordem de compra.' }])
  const o = (
    await scope.trx.rawQuery(
      `select o.*, bp.code as sup_code, bp.name as sup_name, s.payment_terms_days as sup_terms from purchase_orders o
         join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where o.tenant_id = ? and o.id = ?${lock ? ' for update of o' : ''}`,
      [scope.context.tenantId, orderId]
    )
  ).rows[0] as any
  if (!o) throw ApiError.notFound()
  return o
}
/** Factura-se uma ordem emitida (alguma vez) e não anulada. */
const invoiceable = (o: any) => o.issued_revision !== null && o.approval_status !== 'CANCELLED'

async function orderLines(scope: TenantScope, orderId: string, lock = false) {
  return (
    await scope.trx.rawQuery(
      `select * from purchase_order_lines where tenant_id = ? and order_id = ? order by line_no${lock ? ' for update' : ''}`,
      [scope.context.tenantId, orderId]
    )
  ).rows as any[]
}

/** Cabeçalho e linhas (forma, pertença à ordem, valores), na moeda da ordem. */
async function prepare(scope: TenantScope, o: any, input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const invoiceNumber = text(input.invoiceNumber)
  if (!invoiceNumber || invoiceNumber.length > 60)
    issues.push({
      path: 'invoiceNumber',
      code: 'REQUIRED',
      message: 'Número da factura do fornecedor (até 60).',
    })
  const invoiceDate = input.invoiceDate
  if (!isDate(invoiceDate))
    issues.push({ path: 'invoiceDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  else if (invoiceDate > today())
    issues.push({
      path: 'invoiceDate',
      code: 'FUTURE',
      message: 'A factura não pode ter data futura.',
    })
  const terms = Number(o.payment_terms_days ?? o.sup_terms ?? 0)
  let due = input.dueDate
    ? (input.dueDate as string)
    : isDate(invoiceDate)
      ? dueDate(invoiceDate, terms)
      : ''
  if (!isDate(due) || (isDate(invoiceDate) && due < invoiceDate)) {
    issues.push({
      path: 'dueDate',
      code: 'INVALID',
      message: 'Vencimento igual ou posterior à data da factura.',
    })
    due = ''
  }
  const currency = text(input.currency).toUpperCase() || o.currency
  if (currency !== o.currency)
    issues.push({
      path: 'currency',
      code: 'CURRENCY_MISMATCH',
      message: `A factura tem de estar na moeda da ordem (${o.currency}).`,
    })
  const declared = parseScaled(input.declaredTotal, 2)
  if (declared === null)
    issues.push({
      path: 'declaredTotal',
      code: 'REQUIRED',
      message: 'Total da factura, até 2 casas, em texto.',
    })
  const notes = text(input.notes) || null
  const { lines, issues: li } = normalizeInvoiceLines(input.lines)
  issues.push(...li)
  const ols = new Map((await orderLines(scope, o.id)).map((l) => [l.id as string, l]))
  const rows = lines.map((l, i) => {
    const ol = l.orderLineId ? ols.get(l.orderLineId) : null
    if (l.orderLineId && !ol)
      issues.push({
        path: `lines.${i}.orderLineId`,
        code: 'NOT_FOUND',
        message: 'Linha que não é desta ordem.',
      })
    const a = orderLineAmounts(l.quantity, l.unitPrice, l.discountRate, l.taxRate)
    return { ...l, description: l.description || ol?.description || '', a, ol }
  })
  fail(issues)
  const tot = rows.reduce((s, r) => ({ net: s.net + r.a.net, tax: s.tax + r.a.tax }), {
    net: 0n,
    tax: 0n,
  })
  return {
    header: {
      invoice_number: invoiceNumber,
      invoice_number_key: invoiceNumberKey(invoiceNumber),
      invoice_date: invoiceDate as string,
      due_date: due,
      currency,
      declared_total: money(declared!),
      total_net: money(tot.net),
      total_tax: money(tot.tax),
      total_amount: money(tot.net + tot.tax),
      notes,
    },
    rows,
  }
}

/** Já existe esta factura do fornecedor (não anulada)? */
async function duplicateOf(
  scope: TenantScope,
  supplierId: string,
  key: string,
  except: string | null
) {
  const r = await scope.trx.rawQuery(
    `select id, number, status from purchase_invoices where tenant_id = ? and supplier_id = ? and invoice_number_key = ?
       and status <> 'CANCELLED' ${except ? 'and id <> ?' : ''} limit 1`,
    (except
      ? [scope.context.tenantId, supplierId, key, except]
      : [scope.context.tenantId, supplierId, key]) as never[]
  )
  return r.rows[0] as any
}
const duplicateError = (d: any) =>
  new ApiError(409, 'DUPLICATE_INVOICE', 'Esta factura do fornecedor já está registada.', [
    { path: 'invoiceNumber', code: 'DUPLICATE_INVOICE', message: d.id },
  ])

async function writeLines(scope: TenantScope, id: string, rows: any[]) {
  const t = scope.context.tenantId
  const u = scope.context.userId
  await scope.trx.rawQuery(
    `delete from purchase_invoice_lines where tenant_id = ? and invoice_id = ?`,
    [t, id]
  )
  for (const [i, r] of rows.entries())
    await scope.trx.rawQuery(
      `insert into purchase_invoice_lines (tenant_id, invoice_id, line_no, order_line_id, description, quantity, unit_price,
          discount_rate, tax_rate, gross_amount, discount_amount, net_amount, tax_amount, total_amount, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        id,
        i + 1,
        r.orderLineId,
        r.description,
        scaledText(r.quantity, 6),
        scaledText(r.unitPrice, 6),
        scaledText(r.discountRate, 3),
        scaledText(r.taxRate, 3),
        money(r.a.gross),
        money(r.a.discount),
        money(r.a.net),
        money(r.a.tax),
        money(r.a.total),
        u,
        u,
      ] as never[]
    )
}

/** Conferência a três com os números do momento; devolve as divergências e a fotografia por linha. */
async function runMatch(scope: TenantScope, inv: any, lockOrder: boolean) {
  const t = scope.context.tenantId
  const tol = await tolerancesOf(scope)
  const ols = new Map(
    (await orderLines(scope, inv.order_id, lockOrder)).map((l) => [l.id as string, l])
  )
  const lines = (
    await scope.trx.rawQuery(
      `select * from purchase_invoice_lines where tenant_id = ? and invoice_id = ? order by line_no`,
      [t, inv.id]
    )
  ).rows as any[]
  const divergences: Divergence[] = []
  const snapshots = lines.map((l) => {
    const ol = l.order_line_id ? ols.get(l.order_line_id) : null
    const facts = {
      lineNo: Number(l.line_no),
      orderLineId: l.order_line_id ?? null,
      quantity: q6(l.quantity),
      netCents: c2(l.net_amount),
      taxRate: r3(l.tax_rate),
      order: ol
        ? {
            quantity: q6(ol.quantity),
            received: q6(ol.received_quantity),
            invoiced: q6(ol.invoiced_quantity),
            netCents: c2(ol.net_amount),
            taxRate: r3(ol.tax_rate),
          }
        : null,
    }
    const d = matchLine(facts, tol)
    divergences.push(...d)
    return {
      id: l.id as string,
      match: {
        ordered: ol ? scaledText(q6(ol.quantity), 6) : null,
        received: ol ? scaledText(q6(ol.received_quantity), 6) : null,
        invoicedBefore: ol ? scaledText(q6(ol.invoiced_quantity), 6) : null,
        orderNet: ol ? money(c2(ol.net_amount)) : null,
        orderTaxRate: ol ? scaledText(r3(ol.tax_rate), 3) : null,
        codes: d.map((x) => x.code),
      },
    }
  })
  divergences.push(...matchTotal(c2(inv.declared_total), c2(inv.total_amount), tol))
  return { divergences, snapshots, ols, lines, tol }
}

const signature = (d: Divergence[]) =>
  JSON.stringify(d.map((x) => `${x.code}:${x.lineNo ?? ''}`).sort())

/** Fecha a validação: câmbio da data da factura, número interno, facturado na ordem e estado de facturação. */
async function finalize(scope: TenantScope, inv: any, ols: Map<string, any>, lines: any[]) {
  const t = scope.context.tenantId
  const le = (await legalEntityFacts(scope, inv.legal_entity_id))!
  let rate = 10n ** 10n
  if (inv.currency !== le.functionalCurrency) {
    const fx = await rateOn(scope, inv.currency, le.functionalCurrency, isoDate(inv.invoice_date)!)
    if (!fx)
      throw ApiError.conflict(
        'NO_RATE',
        `Sem câmbio ${inv.currency}→${le.functionalCurrency} na data da factura: registe-o em Câmbios.`
      )
    rate = r10(fx.rate)
  }
  const ser = await scope.trx.rawQuery(
    `select id from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ? and status = 'ACTIVE'
        and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
        and branch_id is null order by code limit 1`,
    [t, inv.legal_entity_id, INVOICE_SERIES_TYPE, today(), today()]
  )
  const series = ser.rows[0] as { id: string } | undefined
  if (!series)
    throw ApiError.conflict(
      'NO_SERIES',
      `Sem série documental ${INVOICE_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
    )
  const number = (await reserveDocumentNumber(scope, series.id, today())).formatted
  for (const l of lines) {
    if (!l.order_line_id) continue
    const ol = ols.get(l.order_line_id)!
    const next = q6(ol.invoiced_quantity) + q6(l.quantity)
    await scope.trx.rawQuery(
      `update purchase_order_lines set invoiced_quantity = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?`,
      [scaledText(next, 6), t, ol.id] as never[]
    )
    ol.invoiced_quantity = scaledText(next, 6)
  }
  const status = orderInvoiceStatus(
    [...ols.values()].map((x) => ({
      quantity: q6(x.quantity),
      invoiced: q6(x.invoiced_quantity),
      cancelled: q6(x.cancelled_quantity),
    }))
  )
  await scope.trx.rawQuery(
    `update purchase_orders set invoice_status = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
    [status, t, inv.order_id]
  )
  await setInvoice(scope, inv.id, {
    status: 'VALIDATED',
    series_id: series.id,
    number,
    exchange_rate: scaledText(rate, 10),
    total_functional: money(toFunctional(c2(inv.total_amount), rate)),
    validated_at: new Date(),
    validated_by: scope.context.userId,
  })
  return { number, orderInvoiceStatus: status }
}

async function detail(scope: TenantScope, id: string) {
  const { i, g } = await authorized(scope, id, 'read')
  const t = scope.context.tenantId
  const info = (
    await scope.trx.rawQuery(
      `select o.number as order_number, o.currency as order_currency, le.code as le_code, bp.code as sup_code,
          bp.name as sup_name, us.full_name as submitted_name, uv.full_name as validated_name
         from purchase_invoices i join purchase_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
         join legal_entities le on le.tenant_id = i.tenant_id and le.id = i.legal_entity_id
         join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
         left join users us on us.id = i.submitted_by left join users uv on uv.id = i.validated_by
        where i.tenant_id = ? and i.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  const lines = (
    await scope.trx.rawQuery(
      `select l.*, ol.line_no as order_line_no, ol.uom_code from purchase_invoice_lines l
         left join purchase_order_lines ol on ol.tenant_id = l.tenant_id and ol.id = l.order_line_id
        where l.tenant_id = ? and l.invoice_id = ? order by l.line_no`,
      [t, id]
    )
  ).rows as any[]
  const exceptions = (
    await scope.trx.rawQuery(
      `select x.*, u.full_name as decided_name, ur.full_name as requested_name from purchase_invoice_exceptions x
         left join users u on u.id = x.decided_by left join users ur on ur.id = x.requested_by
        where x.tenant_id = ? and x.invoice_id = ? order by x.created_at desc`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from purchase_invoice_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.invoice_id = ? order by e.created_at desc, e.id`,
      [t, id]
    )
  ).rows as any[]
  const status = i.status as InvoiceStatus
  const me = scope.context.userId
  return {
    id: i.id as string,
    version: Number(i.version),
    number: (i.number as string) ?? null,
    status,
    legalEntity: { id: i.legal_entity_id as string, code: info.le_code as string },
    supplier: {
      id: i.supplier_id as string,
      code: info.sup_code as string,
      name: info.sup_name as string,
    },
    order: { id: i.order_id as string, number: info.order_number as string },
    invoiceNumber: i.invoice_number as string,
    invoiceDate: isoDate(i.invoice_date)!,
    dueDate: isoDate(i.due_date)!,
    currency: i.currency as string,
    declaredTotal: money(c2(i.declared_total)),
    totalNet: money(c2(i.total_net)),
    totalTax: money(c2(i.total_tax)),
    totalAmount: money(c2(i.total_amount)),
    exchangeRate: i.exchange_rate === null ? null : scaledText(r10(i.exchange_rate), 10),
    totalFunctional: i.total_functional === null ? null : money(c2(i.total_functional)),
    notes: (i.notes as string) ?? null,
    divergences: (i.divergences as Divergence[]) ?? [],
    submittedAt: i.submitted_at ? new Date(i.submitted_at).toISOString() : null,
    submittedBy: (info.submitted_name as string) ?? null,
    validatedAt: i.validated_at ? new Date(i.validated_at).toISOString() : null,
    validatedBy: (info.validated_name as string) ?? null,
    rejectReason: (i.reject_reason as string) ?? null,
    cancelReason: (i.cancel_reason as string) ?? null,
    lines: lines.map((l) => ({
      id: l.id as string,
      lineNo: Number(l.line_no),
      orderLineId: (l.order_line_id as string) ?? null,
      orderLineNo: l.order_line_no === null ? null : Number(l.order_line_no),
      description: l.description as string,
      uom: (l.uom_code as string) ?? null,
      quantity: scaledText(q6(l.quantity), 6),
      unitPrice: scaledText(q6(l.unit_price), 6),
      discountRate: scaledText(r3(l.discount_rate), 3),
      taxRate: scaledText(r3(l.tax_rate), 3),
      netAmount: money(c2(l.net_amount)),
      taxAmount: money(c2(l.tax_amount)),
      totalAmount: money(c2(l.total_amount)),
      match: l.match ?? null,
    })),
    exceptions: exceptions.map((x) => ({
      decision: x.decision as 'APPROVE' | 'REJECT',
      reason: x.reason as string,
      divergences: x.divergences as Divergence[],
      requestedBy: (x.requested_name as string) ?? null,
      decidedBy: (x.decided_name as string) ?? null,
      at: new Date(x.created_at).toISOString(),
    })),
    history: events.map((e) => ({
      kind: e.kind as string,
      reason: (e.reason as string) ?? null,
      details: e.details ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: {
      edit: g.manage && status === 'DRAFT',
      validate: g.manage && status === 'DRAFT',
      decide: g.approve && status === 'PENDING_EXCEPTION' && i.submitted_by !== me,
      decideBlockedBy:
        g.approve && status === 'PENDING_EXCEPTION' && i.submitted_by === me
          ? 'SELF_APPROVAL'
          : null,
      refuse: g.manage && (status === 'DRAFT' || status === 'PENDING_EXCEPTION'),
      cancel: g.manage && (status === 'DRAFT' || status === 'PENDING_EXCEPTION'),
    },
  }
}

export type InvoiceDetail = Awaited<ReturnType<typeof detail>>

export class InvoiceService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      orderId?: string
      supplierId?: string
      divergent?: boolean
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const all = s.read.tenant || s.manage.tenant || s.approve.tenant
      const les = [
        ...new Set([
          ...s.read.legalEntityIds,
          ...s.manage.legalEntityIds,
          ...s.approve.legalEntityIds,
        ]),
      ]
      if (!all && !les.length) return { items: [], total: 0 }
      const where = ['i.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!all) {
        where.push('i.legal_entity_id = any(?::uuid[])')
        params.push(les)
      }
      if (f.status && (INVOICE_STATUSES as readonly string[]).includes(f.status)) {
        where.push('i.status = ?')
        params.push(f.status)
      }
      for (const [k, col] of [
        ['orderId', 'i.order_id'],
        ['supplierId', 'i.supplier_id'],
      ] as const)
        if (f[k] && isUuid(f[k])) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      if (f.divergent) where.push(`jsonb_array_length(coalesce(i.divergences, '[]'::jsonb)) > 0`)
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(i.invoice_number) like ? or lower(coalesce(i.number, '')) like ? or lower(o.number) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like, like)
      }
      const from = `from purchase_invoices i join purchase_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
        join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id
        join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select i.*, o.number as order_number, bp.code as sup_code, bp.name as sup_name ${from}
            order by i.created_at desc, i.id limit ? offset ?`,
          [...params, f.limit, f.offset] as never[]
        )
      ).rows as any[]
      const total = Number(
        (
          (await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[]))
            .rows[0] as any
        ).n
      )
      return {
        items: rows.map((i) => ({
          id: i.id as string,
          number: (i.number as string) ?? null,
          status: i.status as InvoiceStatus,
          invoiceNumber: i.invoice_number as string,
          invoiceDate: isoDate(i.invoice_date)!,
          dueDate: isoDate(i.due_date)!,
          supplier: {
            id: i.supplier_id as string,
            code: i.sup_code as string,
            name: i.sup_name as string,
          },
          order: { id: i.order_id as string, number: i.order_number as string },
          currency: i.currency as string,
          totalAmount: money(c2(i.total_amount)),
          divergences: ((i.divergences as unknown[]) ?? []).length,
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  /** O que uma ordem tem por facturar (para o formulário): recebido − facturado por linha, preço e imposto da ordem. */
  invoiceableOrder(context: TenantContext, orderId: string) {
    return runInTenant(context, async (scope) => {
      const o = await loadOrder(scope, orderId)
      if (!rights(await scopesOf(scope), o.legal_entity_id).read) throw ApiError.notFound()
      const ls = await orderLines(scope, o.id)
      return {
        id: o.id as string,
        number: o.number as string,
        invoiceable: invoiceable(o),
        supplier: {
          id: o.supplier_id as string,
          code: o.sup_code as string,
          name: o.sup_name as string,
        },
        currency: o.currency as string,
        paymentTermsDays: o.payment_terms_days ?? o.sup_terms ?? null,
        lines: ls.map((l) => ({
          id: l.id as string,
          lineNo: Number(l.line_no),
          description: l.description as string,
          uom: (l.uom_code as string) ?? null,
          ordered: scaledText(q6(l.quantity), 6),
          received: scaledText(q6(l.received_quantity), 6),
          invoiced: scaledText(q6(l.invoiced_quantity), 6),
          toInvoice: scaledText(
            (() => {
              const v = q6(l.received_quantity) - q6(l.invoiced_quantity)
              return v > 0n ? v : 0n
            })(),
            6
          ),
          unitPrice: scaledText(q6(l.unit_price), 6),
          discountRate: scaledText(r3(l.discount_rate), 3),
          taxRate: scaledText(r3(l.tax_rate), 3),
        })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const o = await loadOrder(scope, input.orderId as string)
      const g = rights(await scopesOf(scope), o.legal_entity_id)
      if (!g.read) throw ApiError.notFound()
      if (!g.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista facturas desta entidade.')
      if (!invoiceable(o))
        throw ApiError.conflict('NOT_INVOICEABLE', 'Só se factura uma ordem emitida e não anulada.')
      // Duplicado primeiro: a mesma factura do fornecedor não precisa de ser preenchida para ser recusada.
      const early = text(input.invoiceNumber)
      const known = early
        ? await duplicateOf(scope, o.supplier_id, invoiceNumberKey(early), null)
        : null
      if (known) throw duplicateError(known)
      const p = await prepare(scope, o, input)
      let id: string
      try {
        const cols = {
          legal_entity_id: o.legal_entity_id,
          supplier_id: o.supplier_id,
          order_id: o.id,
          ...p.header,
        }
        const ins = await scope.trx.rawQuery(
          `insert into purchase_invoices (tenant_id, ${Object.keys(cols).join(', ')}, created_by, updated_by)
           values (?, ${Object.keys(cols)
             .map(() => '?')
             .join(', ')}, ?, ?) returning id`,
          [context.tenantId, ...Object.values(cols), context.userId, context.userId] as never[]
        )
        id = (ins.rows[0] as { id: string }).id
      } catch (e: any) {
        // Duas pessoas a registar a mesma factura ao mesmo tempo: o índice único decide.
        if (
          e?.code === '23505' &&
          String(e?.constraint ?? e?.message).includes('purchase_invoices_external_unique')
        )
          throw duplicateError({ id: null })
        throw e
      }
      await writeLines(scope, id, p.rows)
      await event(scope, id, 'CREATED')
      await audit(scope, {
        action: 'purchase_invoice.created',
        entityType: 'purchase_invoice',
        entityId: id,
        changes: {
          invoiceNumber: { from: null, to: p.header.invoice_number },
          totalAmount: { from: null, to: p.header.total_amount },
        },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { i } = await authorized(scope, id, 'manage', true)
      versionCheck(i, input.expectedVersion)
      if (i.status !== 'DRAFT') throw ApiError.conflict('INVALID_STATE', 'Só se altera o rascunho.')
      const o = await loadOrder(scope, i.order_id)
      const p = await prepare(scope, o, input)
      const dup = await duplicateOf(scope, o.supplier_id, p.header.invoice_number_key, id)
      if (dup) throw duplicateError(dup)
      await writeLines(scope, id, p.rows)
      await setInvoice(scope, id, { ...p.header, divergences: null })
      await event(scope, id, 'UPDATED')
      await audit(scope, {
        action: 'purchase_invoice.updated',
        entityType: 'purchase_invoice',
        entityId: id,
        changes: { totalAmount: { from: money(c2(i.total_amount)), to: p.header.total_amount } },
      })
      return detail(scope, id)
    })
  }

  /** Validar: conferência a três (ordem bloqueada); sem divergências fica validada; com divergências pede excepção. */
  validate(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { i } = await authorized(scope, id, 'manage', true)
      versionCheck(i, input.expectedVersion)
      if (i.status !== 'DRAFT') throw ApiError.conflict('INVALID_STATE', 'Só se valida o rascunho.')
      const o = await loadOrder(scope, i.order_id, true)
      if (!invoiceable(o)) throw ApiError.conflict('NOT_INVOICEABLE', 'A ordem foi anulada.')
      const m = await runMatch(scope, i, true)
      for (const sn of m.snapshots)
        await scope.trx.rawQuery(
          `update purchase_invoice_lines set match = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
          [JSON.stringify(sn.match), context.tenantId, sn.id] as never[]
        )
      await setInvoice(scope, id, {
        divergences: JSON.stringify(m.divergences),
        submitted_at: new Date(),
        submitted_by: context.userId,
      })
      if (m.divergences.length) {
        await setInvoice(scope, id, { status: 'PENDING_EXCEPTION' })
        await event(scope, id, 'DIVERGENT', {
          details: { codes: m.divergences.map((d) => d.code) },
        })
        await audit(scope, {
          action: 'purchase_invoice.divergent',
          entityType: 'purchase_invoice',
          entityId: id,
          changes: { status: { from: 'DRAFT', to: 'PENDING_EXCEPTION' } },
        })
        return detail(scope, id)
      }
      const r = await finalize(scope, await load(scope, id), m.ols, m.lines)
      await event(scope, id, 'VALIDATED', {
        details: { number: r.number, orderInvoiceStatus: r.orderInvoiceStatus },
      })
      await audit(scope, {
        action: 'purchase_invoice.validated',
        entityType: 'purchase_invoice',
        entityId: id,
        changes: {
          status: { from: 'DRAFT', to: 'VALIDATED' },
          number: { from: null, to: r.number },
        },
      })
      return detail(scope, id)
    })
  }

  /**
   * Decidir a excepção (outra pessoa, com motivo). Autorizar refaz a conferência: só valida se as divergências forem as
   * mesmas que se autorizam (`DIVERGENCES_CHANGED` se entretanto mudaram); recusar devolve a factura a rascunho.
   */
  decide(
    context: TenantContext,
    id: string,
    decision: 'approve' | 'reject',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const { i } = await authorized(scope, id, 'approve', true)
      versionCheck(i, input.expectedVersion)
      if (i.status !== 'PENDING_EXCEPTION')
        throw ApiError.conflict('INVALID_STATE', 'A factura não tem excepção pendente.')
      if (i.submitted_by === context.userId)
        throw ApiError.forbidden(
          'SELF_APPROVAL',
          'Pediu esta validação: não pode decidir a excepção.'
        )
      const reason = reasonOf(input.reason)
      const insert = (d: 'APPROVE' | 'REJECT') =>
        scope.trx.rawQuery(
          `insert into purchase_invoice_exceptions (tenant_id, invoice_id, decision, divergences, reason, requested_by,
              decided_by, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            id,
            d,
            JSON.stringify(i.divergences),
            reason,
            i.submitted_by,
            context.userId,
            context.userId,
            context.userId,
          ] as never[]
        )
      if (decision === 'reject') {
        await insert('REJECT')
        await setInvoice(scope, id, { status: 'DRAFT' })
        await event(scope, id, 'EXCEPTION_REJECTED', { reason })
        await audit(scope, {
          action: 'purchase_invoice.exception_rejected',
          entityType: 'purchase_invoice',
          entityId: id,
          changes: { status: { from: 'PENDING_EXCEPTION', to: 'DRAFT' } },
        })
        return detail(scope, id)
      }
      await loadOrder(scope, i.order_id, true)
      const m = await runMatch(scope, i, true)
      if (signature(m.divergences) !== signature((i.divergences as Divergence[]) ?? []))
        throw ApiError.conflict(
          'DIVERGENCES_CHANGED',
          'As divergências mudaram desde o pedido (recepções ou facturas entretanto): recuse e volte a validar.'
        )
      await insert('APPROVE')
      const r = await finalize(scope, i, m.ols, m.lines)
      await event(scope, id, 'EXCEPTION_APPROVED', { reason, details: { number: r.number } })
      await audit(scope, {
        action: 'purchase_invoice.exception_approved',
        entityType: 'purchase_invoice',
        entityId: id,
        changes: {
          status: { from: 'PENDING_EXCEPTION', to: 'VALIDATED' },
          number: { from: null, to: r.number },
        },
      })
      return detail(scope, id)
    })
  }

  /** Devolver ao fornecedor (recusada) ou anular (registada por engano). */
  close(
    context: TenantContext,
    id: string,
    action: 'refuse' | 'cancel',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const { i } = await authorized(scope, id, 'manage', true)
      versionCheck(i, input.expectedVersion)
      if (!['DRAFT', 'PENDING_EXCEPTION'].includes(i.status))
        throw ApiError.conflict('INVALID_STATE', 'Validada, corrige-se com nota de crédito.')
      const reason = reasonOf(input.reason)
      const to = action === 'refuse' ? 'REJECTED' : 'CANCELLED'
      await setInvoice(scope, id, {
        status: to,
        ...(action === 'refuse' ? { reject_reason: reason } : { cancel_reason: reason }),
      })
      await event(scope, id, to, { reason })
      await audit(scope, {
        action: action === 'refuse' ? 'purchase_invoice.refused' : 'purchase_invoice.cancelled',
        entityType: 'purchase_invoice',
        entityId: id,
        changes: { status: { from: i.status, to } },
      })
      return detail(scope, id)
    })
  }

  tolerances(context: TenantContext) {
    return runInTenant(context, async (scope) => toleranceView(await tolerancesOf(scope)))
  }

  setTolerances(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { tolerances, issues } = normalizeTolerances(input)
      fail(issues)
      const before = await tolerancesOf(scope)
      await scope.trx.rawQuery(
        `insert into procurement_tolerances (tenant_id, price_pct, price_amount, qty_pct, total_amount, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (tenant_id) do update set price_pct = excluded.price_pct, price_amount = excluded.price_amount,
           qty_pct = excluded.qty_pct, total_amount = excluded.total_amount, updated_by = excluded.updated_by,
           updated_at = now(), version = procurement_tolerances.version + 1`,
        [
          context.tenantId,
          scaledText(tolerances.pricePct, 3),
          money(tolerances.priceAmount),
          scaledText(tolerances.qtyPct, 3),
          money(tolerances.totalAmount),
          context.userId,
          context.userId,
        ] as never[]
      )
      const b = toleranceView(before)
      const a = toleranceView(tolerances)
      await audit(scope, {
        action: 'procurement.tolerances_updated',
        entityType: 'procurement_tolerances',
        entityId: context.tenantId,
        changes: Object.fromEntries(
          (Object.keys(a) as (keyof typeof a)[])
            .filter((k) => a[k] !== b[k])
            .map((k) => [k, { from: b[k], to: a[k] }])
        ),
      })
      return a
    })
  }
}

/** Existe nesta empresa e o membro pode ler (anexos): `null` sem acesso. */
export async function purchaseInvoiceAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const i = (
    await scope.trx.rawQuery(
      `select legal_entity_id from purchase_invoices where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!i) return null
  const g = rights(await scopesOf(scope), i.legal_entity_id)
  return g.read ? { read: true, write: g.manage } : null
}
