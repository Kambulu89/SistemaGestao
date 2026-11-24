import { createHash } from 'node:crypto'
import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { allocateFiscalNumber } from '#modules/sales/application/fiscal_service'
import { enqueueFiscalDocument } from '#modules/sales/application/fiscal_integration_service'
import {
  adjustInvoice,
  applyInvoicePayment,
  invoiceForNote,
  invoiceForPayment,
} from '#modules/sales/application/invoice_service'
import { recordReturnCredit, returnForNote } from '#modules/sales/application/order_service'
import { computeTaxes, type RoundingLevel } from '#modules/sales/domain/fiscal'
import { documentHash } from '#modules/sales/domain/invoices'
import {
  type LineRoom,
  NOTE_KINDS,
  NOTE_STATUSES,
  type NoteKind,
  type NoteLineInput,
  noteLineNet,
  normalizeNoteHeader,
  normalizeNoteLines,
  originalTaxes,
  qtyShort,
  reasonIssue,
} from '#modules/sales/domain/notes'
import { dbScaled, parseScaled, QTY_SCALE, scaledText } from '#modules/sales/domain/pricing'

/*
 * Notas de crédito e débito e reembolsos (10.8). Permissões no âmbito da entidade legal: `sales.notes.read`,
 * `.manage` (rascunhos, descartar, aplicar crédito a outra factura) e `.issue` (emitir; a nota de crédito nunca por
 * quem a criou). Reembolsos: registo com `sales.receipts.manage` e confirmação financeira por outra pessoa com
 * `sales.receipts.confirm` (o contrato que a Tesouraria do Prompt 11 vai usar). A devolução física é da encomenda
 * (`returnGoods`); aqui só se liga a nota à devolução para não creditar por devolução mais do que voltou.
 */

const today = () => new Date().toISOString().slice(0, 10)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const money = (v: unknown) => scaledText(dbScaled(v, 2), 2)
const cents = (v: unknown) => dbScaled(v, 2)
const qty = (v: unknown) => dbScaled(v, QTY_SCALE)
const METHODS = ['CASH', 'TRANSFER', 'CARD', 'CHEQUE', 'OTHER'] as const
const REFUND_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED'] as const

type Need = 'read' | 'manage' | 'issue' | 'pay' | 'confirm'
async function scopesOf(scope: TenantScope): Promise<Record<Need, PermissionScope>> {
  return {
    read: await permissionScope(scope, 'sales.notes.read'),
    manage: await permissionScope(scope, 'sales.notes.manage'),
    issue: await permissionScope(scope, 'sales.notes.issue'),
    pay: await permissionScope(scope, 'sales.receipts.manage'),
    confirm: await permissionScope(scope, 'sales.receipts.confirm'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
function rights(s: Record<Need, PermissionScope>, le: string) {
  const manage = covers(s.manage, le)
  const issue = covers(s.issue, le)
  const pay = covers(s.pay, le)
  const confirm = covers(s.confirm, le)
  return {
    read: manage || issue || pay || confirm || covers(s.read, le),
    manage,
    issue,
    pay,
    confirm,
  }
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select *, note_date::text as ndate from sales_notes where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}
const DENY: Record<Need, string> = {
  read: 'Não consulta notas desta entidade.',
  manage: 'Não gere notas desta entidade.',
  issue: 'Não emite notas desta entidade.',
  pay: 'Não regista reembolsos desta entidade.',
  confirm: 'Não confirma reembolsos desta entidade.',
}
async function authorized(scope: TenantScope, id: string, need: Need, lock = false) {
  const n = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), n.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (!g[need]) throw ApiError.forbidden('OUT_OF_SCOPE', DENY[need])
  return { n, g }
}
const versionCheck = (r: any, expected: unknown) => {
  if (Number(r.version) !== Number(expected)) throw ApiError.versionConflict(Number(r.version))
}
async function setNote(scope: TenantScope, id: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields)
  await scope.trx.rawQuery(
    `update sales_notes set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
      where tenant_id = ? and id = ?`,
    [...cols.map((c) => fields[c]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}
const reasonOf = (v: unknown) => {
  const r = typeof v === 'string' ? v.trim() : ''
  if (r.length < 3 || r.length > 500)
    fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' }])
  return r
}

/** Quantidade e valor já creditados por linha da factura (só notas de crédito emitidas; opcionalmente sem uma). */
async function creditedByLine(scope: TenantScope, invoiceId: string, exceptNoteId?: string) {
  const rows = (
    await scope.trx.rawQuery(
      `select l.invoice_line_id, coalesce(sum(l.quantity), 0)::text as q, coalesce(sum(l.net_amount), 0)::text as v
         from sales_note_lines l join sales_notes n on n.tenant_id = l.tenant_id and n.id = l.note_id
        where l.tenant_id = ? and n.invoice_id = ? and n.kind = 'CREDIT' and n.status = 'ISSUED' and n.id <> ?
        group by l.invoice_line_id`,
      [scope.context.tenantId, invoiceId, exceptNoteId ?? '00000000-0000-0000-0000-000000000000']
    )
  ).rows as any[]
  return new Map(rows.map((r) => [r.invoice_line_id as string, { q: qty(r.q), v: cents(r.v) }]))
}

/** Retenções aplicadas na factura (pelo resumo dos impostos): só essas se estornam na nota. */
const appliedWithholdings = (inv: any) =>
  new Set(
    (((inv.tax_summary as any)?.summary as any[]) ?? [])
      .filter((s) => s.kind === 'WITHHOLDING' && s.applied)
      .map((s) => s.codeId as string)
  )

/**
 * Calcula as linhas da nota sobre a factura original: valor elegível e impostos das linhas originais. Devolve também
 * os totais e o resumo. Com devolução ligada, o crédito por quantidade de produtos da encomenda não passa o devolvido.
 */
async function computeNote(
  scope: TenantScope,
  kind: NoteKind,
  invoice: NonNullable<Awaited<ReturnType<typeof invoiceForNote>>>,
  lines: NoteLineInput[],
  returnId: string | null,
  exceptNoteId?: string
) {
  const credited = await creditedByLine(scope, invoice.i.id, exceptNoteId)
  const issues: ErrorDetail[] = []
  let ret: Awaited<ReturnType<typeof returnForNote>> = null
  let returnedCredited = new Map<string, bigint>()
  if (returnId) {
    ret = await returnForNote(scope, returnId)
    if (!ret || ret.orderId !== invoice.i.order_id)
      issues.push({
        path: 'returnId',
        code: 'NOT_FOUND',
        message: 'A devolução não é da encomenda desta factura.',
      })
    else {
      const rows = (
        await scope.trx.rawQuery(
          `select il.order_line_id, coalesce(sum(l.quantity), 0)::text as q from sales_note_lines l
             join sales_notes n on n.tenant_id = l.tenant_id and n.id = l.note_id
             join sales_invoice_lines il on il.tenant_id = l.tenant_id and il.id = l.invoice_line_id
            where l.tenant_id = ? and n.return_id = ? and n.status = 'ISSUED' and n.id <> ? and l.mode = 'QUANTITY'
            group by il.order_line_id`,
          [scope.context.tenantId, returnId, exceptNoteId ?? '00000000-0000-0000-0000-000000000000']
        )
      ).rows as any[]
      returnedCredited = new Map(rows.map((r) => [r.order_line_id as string, qty(r.q)]))
    }
  }
  const held = appliedWithholdings(invoice.i)
  const out: {
    input: NoteLineInput
    original: any
    net: bigint
  }[] = []
  lines.forEach((l, i) => {
    const o = invoice.lines.find((x) => x.id === l.invoiceLineId)
    if (!o)
      return issues.push({
        path: `lines.${i}.invoiceLineId`,
        code: 'NOT_FOUND',
        message: 'Linha inexistente nesta factura.',
      })
    const c = credited.get(o.id) ?? { q: 0n, v: 0n }
    const room: LineRoom = {
      quantity: qty(o.quantity),
      netUnitPrice: String(o.net_unit_price ?? '0'),
      netAmount: cents(o.net_amount),
      creditedQty: c.q,
      creditedNet: c.v,
    }
    const r = noteLineNet(kind, l, room)
    if (r.issue) return issues.push({ ...r.issue, path: `lines.${i}.${r.issue.path}` })
    if (ret && l.mode === 'QUANTITY') {
      const back = o.order_line_id ? (ret.lines.get(o.order_line_id) ?? 0n) : 0n
      const already = o.order_line_id ? (returnedCredited.get(o.order_line_id) ?? 0n) : 0n
      if (l.quantity! > back - already)
        return issues.push({
          path: `lines.${i}.quantity`,
          code: 'OVER_RETURNED',
          message: `Da devolução ${ret.reference} só há ${qtyShort(back - already > 0n ? back - already : 0n)} por creditar nesta linha.`,
        })
    }
    out.push({ input: l, original: o, net: r.net })
  })
  fail(issues)
  const taxes = computeTaxes(
    out.map((x, n) => ({
      key: String(n),
      netAmount: scaledText(x.net, 2),
      taxes: originalTaxes((x.original.taxes as any[]) ?? [], held),
    })),
    (invoice.i.rounding_level ?? 'LINE') as RoundingLevel
  )
  return { lines: out, taxes, ret }
}

async function writeNoteLines(
  scope: TenantScope,
  noteId: string,
  c: Awaited<ReturnType<typeof computeNote>>
) {
  const t = scope.context.tenantId
  await scope.trx.rawQuery(`delete from sales_note_lines where tenant_id = ? and note_id = ?`, [
    t,
    noteId,
  ])
  let n = 0
  for (const x of c.lines) {
    const tl = c.taxes.lines[n]
    const taxSum = tl.taxes
      .filter((y) => y.kind === 'TAX')
      .reduce((a, y) => a + parseScaled(y.amount, 6)!, 0n)
    n++
    await scope.trx.rawQuery(
      `insert into sales_note_lines (tenant_id, note_id, line_no, invoice_line_id, mode, quantity, description, net_amount,
         tax_amount, taxes, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        noteId,
        n,
        x.input.invoiceLineId,
        x.input.mode,
        x.input.quantity === null ? null : scaledText(x.input.quantity, QTY_SCALE),
        x.original.description,
        scaledText(x.net, 2),
        scaledText(taxSum, 6),
        JSON.stringify(tl.taxes),
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
  }
  const tot = c.taxes.totals
  await setNote(scope, noteId, {
    net_total: tot.net,
    tax_total: tot.tax,
    gross_total: tot.gross,
    withholding_total: tot.withholding,
    payable_total: tot.payable,
    tax_summary: JSON.stringify(c.taxes.summary),
  })
}

async function storedLines(scope: TenantScope, noteId: string): Promise<NoteLineInput[]> {
  return (
    (
      await scope.trx.rawQuery(
        `select invoice_line_id, mode, quantity, net_amount from sales_note_lines where tenant_id = ? and note_id = ? order by line_no`,
        [scope.context.tenantId, noteId]
      )
    ).rows as any[]
  ).map((l) => ({
    invoiceLineId: l.invoice_line_id,
    mode: l.mode,
    quantity: l.quantity === null ? null : qty(l.quantity),
    amount: l.mode === 'VALUE' ? cents(l.net_amount) : null,
  }))
}

/** Reembolsos pendentes de uma nota (reservam crédito até à decisão). */
async function pendingRefunds(scope: TenantScope, noteId: string) {
  return cents(
    (
      (
        await scope.trx.rawQuery(
          `select coalesce(sum(amount), 0)::text as s from sales_refunds where tenant_id = ? and note_id = ? and status = 'PENDING'`,
          [scope.context.tenantId, noteId]
        )
      ).rows[0] as any
    ).s
  )
}
const available = (n: any) =>
  cents(n.payable_total) - cents(n.applied_total) - cents(n.refunded_total)

async function detail(scope: TenantScope, id: string, g?: ReturnType<typeof rights>) {
  const t = scope.context.tenantId
  const n = (
    await scope.trx.rawQuery(
      `select n.*, n.note_date::text as ndate, le.code as le_code, le.legal_name as le_name, bp.code as cus_code,
              bp.name as cus_name, i.number as inv_number, i.invoice_date::text as inv_date, i.order_id, o.number as o_number,
              r.reference as ret_ref, s.code as s_code, s.mode as s_mode, cu.full_name as creator, iu.full_name as issuer
         from sales_notes n
         join legal_entities le on le.tenant_id = n.tenant_id and le.id = n.legal_entity_id
         join customers c on c.tenant_id = n.tenant_id and c.id = n.customer_id
         join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
         join sales_invoices i on i.tenant_id = n.tenant_id and i.id = n.invoice_id
         left join sales_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
         left join sales_returns r on r.tenant_id = n.tenant_id and r.id = n.return_id
         left join fiscal_series s on s.tenant_id = n.tenant_id and s.id = n.series_id
         left join users cu on cu.id = n.created_by
         left join users iu on iu.id = n.issued_by
        where n.tenant_id = ? and n.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!n) throw ApiError.notFound()
  const lines = (
    await scope.trx.rawQuery(
      `select l.*, il.line_no as inv_line_no, il.quantity as inv_qty, il.uom_code, il.net_unit_price, p.sku
         from sales_note_lines l join sales_invoice_lines il on il.tenant_id = l.tenant_id and il.id = l.invoice_line_id
         join products p on p.tenant_id = il.tenant_id and p.id = il.product_id
        where l.tenant_id = ? and l.note_id = ? order by l.line_no`,
      [t, id]
    )
  ).rows as any[]
  const applications = (
    await scope.trx.rawQuery(
      `select x.invoice_id, x.amount, x.created_at, i.number, u.full_name from sales_note_applications x
         join sales_invoices i on i.tenant_id = x.tenant_id and i.id = x.invoice_id left join users u on u.id = x.created_by
        where x.tenant_id = ? and x.note_id = ? order by x.created_at`,
      [t, id]
    )
  ).rows as any[]
  const refunds = (
    await scope.trx.rawQuery(
      `select f.*, f.refund_date::text as fdate, ba.bank_name, ba.holder_name, cu.full_name as creator, fu.full_name as confirmer
         from sales_refunds f left join bank_accounts ba on ba.tenant_id = f.tenant_id and ba.id = f.bank_account_id
         left join users cu on cu.id = f.created_by left join users fu on fu.id = f.confirmed_by
        where f.tenant_id = ? and f.note_id = ? order by f.created_at`,
      [t, id]
    )
  ).rows as any[]
  const a = g ?? rights(await scopesOf(scope), n.legal_entity_id)
  const me = scope.context.userId
  const draft = n.status === 'DRAFT'
  const issued = n.status === 'ISSUED'
  const pending = refunds
    .filter((f) => f.status === 'PENDING')
    .reduce((s, f) => s + cents(f.amount), 0n)
  const free = issued && n.kind === 'CREDIT' ? available(n) - pending : 0n
  // Facturas do mesmo cliente, entidade e moeda com valor em dívida (para usar o crédito).
  const openInvoices =
    a.manage && free > 0n
      ? ((
          await scope.trx.rawQuery(
            `select id, number, payable_total + debited_total - credited_total - paid_total as open from sales_invoices
              where tenant_id = ? and legal_entity_id = ? and customer_id = ? and currency = ? and status in ('ISSUED','CORRECTED')
                and paid_total + credited_total < payable_total + debited_total order by due_date, number`,
            [t, n.legal_entity_id, n.customer_id, n.currency]
          )
        ).rows as any[])
      : []
  return {
    id: n.id as string,
    version: Number(n.version),
    kind: n.kind as NoteKind,
    number: (n.number as string) ?? null,
    status: n.status as string,
    fiscalStatus: (n.fiscal_status as string) ?? null,
    simulation: n.series_id ? n.s_mode === 'SIMULATION' : true,
    legalEntity: {
      id: n.legal_entity_id as string,
      code: n.le_code as string,
      name: n.le_name as string,
    },
    customer: {
      id: n.customer_id as string,
      code: n.cus_code as string,
      name: n.cus_name as string,
    },
    customerSnapshot: n.customer_snapshot as Record<string, unknown>,
    invoice: {
      id: n.invoice_id as string,
      number: n.inv_number as string,
      date: n.inv_date as string,
    },
    order: n.order_id ? { id: n.order_id as string, number: n.o_number as string } : null,
    returnDoc: n.return_id ? { id: n.return_id as string, reference: n.ret_ref as string } : null,
    series: n.series_id ? { id: n.series_id as string, code: n.s_code as string } : null,
    reasonCode: n.reason_code as string,
    reason: n.reason as string,
    noteDate: n.ndate as string,
    currency: String(n.currency).trim(),
    exchangeRate: scaledText(dbScaled(n.exchange_rate, 10), 10),
    netTotal: money(n.net_total),
    taxTotal: money(n.tax_total),
    grossTotal: money(n.gross_total),
    withholdingTotal: money(n.withholding_total),
    payableTotal: money(n.payable_total),
    taxSummary: (n.tax_summary as any[]) ?? [],
    appliedTotal: money(n.applied_total),
    refundedTotal: money(n.refunded_total),
    pendingRefunds: scaledText(pending, 2),
    availableCredit: scaledText(free > 0n ? free : 0n, 2),
    documentHash: (n.document_hash as string) ?? null,
    createdBy: (n.creator as string) ?? null,
    issuedBy: (n.issuer as string) ?? null,
    issuedAt: n.issued_at ? new Date(n.issued_at).toISOString() : null,
    discardReason: (n.discard_reason as string) ?? null,
    lines: lines.map((l) => ({
      id: l.id as string,
      lineNo: Number(l.line_no),
      invoiceLineId: l.invoice_line_id as string,
      invoiceLineNo: Number(l.inv_line_no),
      sku: l.sku as string,
      description: l.description as string,
      mode: l.mode as string,
      quantity: l.quantity === null ? null : scaledText(qty(l.quantity), QTY_SCALE),
      uom: l.uom_code as string,
      netAmount: money(l.net_amount),
      taxAmount: scaledText(dbScaled(l.tax_amount, 6), 6),
      taxes: (l.taxes as any[]) ?? [],
    })),
    applications: applications.map((x) => ({
      invoiceId: x.invoice_id as string,
      number: x.number as string,
      amount: money(x.amount),
      at: new Date(x.created_at).toISOString(),
      by: (x.full_name as string) ?? null,
    })),
    refunds: refunds.map((f) => ({
      id: f.id as string,
      version: Number(f.version),
      amount: money(f.amount),
      method: f.method as string,
      bankAccount: f.bank_account_id ? `${f.bank_name} — ${f.holder_name}` : null,
      reference: (f.reference as string) ?? null,
      refundDate: f.fdate as string,
      status: f.status as string,
      registeredBy: (f.creator as string) ?? null,
      confirmedBy: (f.confirmer as string) ?? null,
      decisionReason: (f.decision_reason as string) ?? null,
      can: {
        confirm: a.confirm && f.status === 'PENDING' && f.created_by !== me,
        reject: a.confirm && f.status === 'PENDING',
        cancel: a.pay && f.status === 'PENDING',
      },
    })),
    openInvoices: openInvoices.map((x) => ({
      id: x.id as string,
      number: x.number as string,
      open: money(x.open),
    })),
    can: {
      edit: a.manage && draft,
      issue: a.issue && draft && (n.kind === 'DEBIT' || n.created_by !== me),
      discard: a.manage && draft,
      applyCredit: a.manage && free > 0n,
      refund: a.pay && free > 0n,
    },
  }
}
export type NoteView = Awaited<ReturnType<typeof detail>>

/** Série fiscal do tipo da nota, da entidade e do ano: a indicada ou a única activa. */
async function noteSeries(scope: TenantScope, n: any, wanted: unknown) {
  if (typeof wanted === 'string' && wanted) return wanted
  const kind = n.kind === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE'
  const year = Number(String(n.ndate).slice(0, 4))
  const ser = (
    await scope.trx.rawQuery(
      `select id, code from fiscal_series where tenant_id = ? and legal_entity_id = ? and document_kind = ? and status = 'ACTIVE' and fiscal_year = ? order by code`,
      [scope.context.tenantId, n.legal_entity_id, kind, year]
    )
  ).rows as any[]
  const label = n.kind === 'CREDIT' ? 'notas de crédito' : 'notas de débito'
  if (!ser.length)
    throw ApiError.conflict(
      'NO_SERIES',
      `Sem série fiscal de ${label} activa para ${year} nesta entidade.`
    )
  if (ser.length > 1)
    throw new ApiError(
      409,
      'SERIES_REQUIRED',
      `Há várias séries de ${label} activas: escolha uma.`,
      [
        {
          path: 'seriesId',
          code: 'REQUIRED',
          message: `Escolha a série (${ser.map((x) => x.code).join(', ')}).`,
        },
      ]
    )
  return ser[0].id as string
}

export class NoteService {
  list(
    context: TenantContext,
    f: {
      q?: string
      kind?: string
      status?: string
      invoiceId?: string
      customerId?: string
      credit?: boolean
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const all = [s.read, s.manage, s.issue, s.pay, s.confirm]
      const where = ['n.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!all.some((x) => x.tenant)) {
        const les = [...new Set(all.flatMap((x) => [...x.legalEntityIds]))]
        if (!les.length) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar notas.')
        where.push(`n.legal_entity_id in (${les.map(() => '?').join(', ')})`)
        params.push(...les)
      }
      if (f.kind && (NOTE_KINDS as readonly string[]).includes(f.kind))
        (where.push('n.kind = ?'), params.push(f.kind))
      if (f.status && (NOTE_STATUSES as readonly string[]).includes(f.status))
        (where.push('n.status = ?'), params.push(f.status))
      for (const [k, col] of [
        ['invoiceId', 'n.invoice_id'],
        ['customerId', 'n.customer_id'],
      ] as const)
        if (f[k] && isUuid(f[k])) (where.push(`${col} = ?`), params.push(f[k]))
      if (f.credit)
        where.push(
          `n.kind = 'CREDIT' and n.status = 'ISSUED' and n.applied_total + n.refunded_total < n.payable_total`
        )
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(n.number, '')) like ? or lower(i.number) like ? or lower(bp.code) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like, like)
      }
      const from = `from sales_notes n join sales_invoices i on i.tenant_id = n.tenant_id and i.id = n.invoice_id
        join customers c on c.tenant_id = n.tenant_id and c.id = n.customer_id
        join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select n.*, n.note_date::text as ndate, i.number as inv_number, bp.code as cus_code, bp.name as cus_name
             ${from} order by n.created_at desc, n.id limit ? offset ?`,
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
        items: rows.map((n) => ({
          id: n.id as string,
          kind: n.kind as string,
          number: (n.number as string) ?? null,
          invoiceNumber: n.inv_number as string,
          customer: { code: n.cus_code as string, name: n.cus_name as string },
          noteDate: n.ndate as string,
          reasonCode: n.reason_code as string,
          currency: String(n.currency).trim(),
          payableTotal: money(n.payable_total),
          availableCredit:
            n.kind === 'CREDIT' && n.status === 'ISSUED' ? scaledText(available(n), 2) : null,
          status: n.status as string,
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const { g } = await authorized(scope, id, 'read')
      return detail(scope, id, g)
    })
  }

  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      const series = (
        await scope.trx.rawQuery(
          `select id, code, prefix, legal_entity_id, fiscal_year, document_kind from fiscal_series where tenant_id = ?
              and document_kind in ('CREDIT_NOTE','DEBIT_NOTE') and status = 'ACTIVE' order by code`,
          [t]
        )
      ).rows as any[]
      const banks = (
        await scope.trx.rawQuery(
          `select id, legal_entity_id, bank_name, holder_name, currency from bank_accounts where tenant_id = ? and status = 'ACTIVE' order by bank_name`,
          [t]
        )
      ).rows as any[]
      return {
        series: series.map((x) => ({
          id: x.id as string,
          code: x.code as string,
          prefix: x.prefix as string,
          legalEntityId: x.legal_entity_id as string,
          fiscalYear: Number(x.fiscal_year),
          documentKind: x.document_kind as string,
        })),
        bankAccounts: banks.map((b) => ({
          id: b.id as string,
          legalEntityId: b.legal_entity_id as string,
          label: `${b.bank_name} — ${b.holder_name}`,
          currency: String(b.currency).trim(),
        })),
      }
    })
  }

  /** Facturas emitidas que se podem corrigir (pesquisa por número ou cliente). */
  searchInvoices(context: TenantContext, q: string) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!(s.manage.tenant || s.manage.legalEntityIds.size))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere notas.')
      const like = `%${(q ?? '').toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
      const rows = (
        await scope.trx.rawQuery(
          `select i.id, i.number, i.legal_entity_id, i.invoice_date::text as d, i.currency, i.payable_total, bp.code, bp.name
             from sales_invoices i join customers c on c.tenant_id = i.tenant_id and c.id = i.customer_id
             join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
            where i.tenant_id = ? and i.status in ('ISSUED','CORRECTED')
              and (lower(i.number) like ? or lower(bp.code) like ? or lower(bp.name) like ?)
            order by i.issued_at desc limit 20`,
          [context.tenantId, like, like, like]
        )
      ).rows as any[]
      return rows
        .filter((r) => covers(s.manage, r.legal_entity_id))
        .map((r) => ({
          id: r.id as string,
          code: r.number as string,
          name: `${r.code} — ${r.name} · ${r.d} · ${money(r.payable_total)} ${String(r.currency).trim()}`,
        }))
    })
  }

  /** Linhas da factura com o que resta creditar, e as devoluções físicas da encomenda (para ligar). */
  eligible(context: TenantContext, invoiceId: string) {
    return runInTenant(context, async (scope) => {
      const inv = await invoiceForNote(scope, invoiceId)
      if (!inv) throw ApiError.notFound()
      const g = rights(await scopesOf(scope), inv.i.legal_entity_id)
      if (!g.read) throw ApiError.notFound()
      if (!['ISSUED', 'CORRECTED'].includes(inv.i.status))
        throw ApiError.conflict('INVOICE_NOT_ISSUED', 'Só se corrige uma factura emitida.')
      const credited = await creditedByLine(scope, invoiceId)
      const returns = inv.i.order_id
        ? ((
            await scope.trx.rawQuery(
              `select id, reference, return_date::text as d from sales_returns where tenant_id = ? and order_id = ? order by seq`,
              [context.tenantId, inv.i.order_id]
            )
          ).rows as any[])
        : []
      return {
        invoice: {
          id: inv.i.id as string,
          number: inv.i.number as string,
          legalEntityId: inv.i.legal_entity_id as string,
          invoiceDate: inv.i.idate as string,
          currency: String(inv.i.currency).trim(),
          payableTotal: money(inv.i.payable_total),
          openTotal: scaledText(inv.open, 2),
          creditedTotal: money(inv.i.credited_total),
          debitedTotal: money(inv.i.debited_total),
        },
        lines: inv.lines.map((l) => {
          const c = credited.get(l.id) ?? { q: 0n, v: 0n }
          return {
            id: l.id as string,
            lineNo: Number(l.line_no),
            sku: l.sku as string,
            description: l.description as string,
            uom: l.uom_code as string,
            quantity: scaledText(qty(l.quantity), QTY_SCALE),
            netUnitPrice: String(l.net_unit_price ?? '0'),
            netAmount: money(l.net_amount),
            creditedQty: scaledText(c.q, QTY_SCALE),
            creditedNet: scaledText(c.v, 2),
            remainingQty: scaledText(qty(l.quantity) - c.q, QTY_SCALE),
            remainingNet: scaledText(cents(l.net_amount) - c.v, 2),
            taxes: ((l.taxes as any[]) ?? []).map((x) => ({
              code: x.code,
              rate: x.rate,
              kind: x.kind,
            })),
          }
        }),
        returns: returns.map((r) => ({
          id: r.id as string,
          reference: r.reference as string,
          date: r.d as string,
        })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, issues } = normalizeNoteHeader(input, true)
      const r = v.kind ? reasonIssue(v.kind, v.reasonCode) : null
      const nl = v.kind ? normalizeNoteLines(input.lines, v.kind) : { lines: [], issues: [] }
      fail([...issues, ...(r ? [r] : []), ...nl.issues])
      const inv = await invoiceForNote(scope, v.invoiceId!)
      if (!inv) fail([{ path: 'invoiceId', code: 'NOT_FOUND', message: 'Factura inexistente.' }])
      const i = inv!.i
      if (!covers((await scopesOf(scope)).manage, i.legal_entity_id))
        throw ApiError.forbidden('OUT_OF_SCOPE', DENY.manage)
      if (!['ISSUED', 'CORRECTED'].includes(i.status))
        throw ApiError.conflict('INVOICE_NOT_ISSUED', 'Só se corrige uma factura emitida.')
      if (v.returnId && v.kind !== 'CREDIT')
        fail([
          {
            path: 'returnId',
            code: 'NOT_ALLOWED',
            message: 'Só a nota de crédito se liga a uma devolução.',
          },
        ])
      const c = await computeNote(scope, v.kind!, inv!, nl.lines, v.returnId ?? null)
      const ins = await scope.trx.rawQuery(
        `insert into sales_notes (tenant_id, kind, invoice_id, legal_entity_id, customer_id, return_id, reason_code, reason,
           note_date, currency, functional_currency, exchange_rate, customer_version_id, customer_snapshot, rounding_level,
           created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          v.kind,
          i.id,
          i.legal_entity_id,
          i.customer_id,
          v.returnId ?? null,
          v.reasonCode,
          v.reason,
          v.noteDate,
          String(i.currency).trim(),
          String(i.functional_currency).trim(),
          i.exchange_rate,
          i.customer_version_id,
          JSON.stringify(i.customer_snapshot),
          i.rounding_level ?? 'LINE',
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as any).id as string
      await writeNoteLines(scope, id, c)
      await audit(scope, {
        action: 'sales_note.created',
        entityType: 'sales_note',
        entityId: id,
        metadata: { kind: v.kind, invoice: i.number, reasonCode: v.reasonCode },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { n } = await authorized(scope, id, 'manage', true)
      versionCheck(n, input.expectedVersion)
      if (n.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se altera uma nota em rascunho.')
      const { expectedVersion, lines: rawLines, kind, invoiceId, ...rest } = input
      const { v, issues } = normalizeNoteHeader(rest, false)
      const r = reasonIssue(n.kind, v.reasonCode)
      const nl = rawLines === undefined ? null : normalizeNoteLines(rawLines, n.kind)
      fail([...issues, ...(r ? [r] : []), ...(nl?.issues ?? [])])
      if (v.returnId && n.kind !== 'CREDIT')
        fail([
          {
            path: 'returnId',
            code: 'NOT_ALLOWED',
            message: 'Só a nota de crédito se liga a uma devolução.',
          },
        ])
      const map: Record<string, string> = {
        reasonCode: 'reason_code',
        reason: 'reason',
        noteDate: 'note_date',
        returnId: 'return_id',
      }
      const fields = Object.fromEntries(
        Object.entries(map)
          .filter(([k]) => k in v)
          .map(([k, col]) => [col, (v as any)[k]])
      )
      const inv = (await invoiceForNote(scope, n.invoice_id))!
      const c = await computeNote(
        scope,
        n.kind,
        inv,
        nl ? nl.lines : await storedLines(scope, id),
        'returnId' in v ? (v.returnId ?? null) : n.return_id,
        id
      )
      if (Object.keys(fields).length) await setNote(scope, id, fields)
      await writeNoteLines(scope, id, c)
      await audit(scope, {
        action: 'sales_note.updated',
        entityType: 'sales_note',
        entityId: id,
        metadata: { fields: Object.keys(fields), lines: nl ? nl.lines.length : undefined },
      })
      return detail(scope, id)
    })
  }

  /**
   * Emitir: bloqueia a factura original, recalcula o elegível (com as notas emitidas entretanto), numera pela série
   * fiscal do tipo (simulação), fixa a impressão digital e aplica à factura: o crédito abate o que está em dívida (o
   * resto fica como crédito do cliente) e o débito aumenta-o. A nota de crédito nunca é emitida por quem a criou.
   */
  issue(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { n } = await authorized(scope, id, 'issue', true)
      if (n.status !== 'DRAFT')
        throw ApiError.conflict('ALREADY_ISSUED', 'A nota já foi emitida ou descartada.')
      versionCheck(n, input.expectedVersion)
      if (n.kind === 'CREDIT' && n.created_by === context.userId)
        throw ApiError.forbidden(
          'SELF_ISSUE',
          'A nota de crédito é emitida por outra pessoa que não quem a criou.'
        )
      const inv = (await invoiceForNote(scope, n.invoice_id, true))!
      if (!['ISSUED', 'CORRECTED'].includes(inv.i.status))
        throw ApiError.conflict('INVOICE_NOT_ISSUED', 'Só se corrige uma factura emitida.')
      if (n.ndate > today())
        fail([{ path: 'noteDate', code: 'FUTURE', message: 'A data da nota não pode ser futura.' }])
      if (n.ndate < inv.i.idate)
        fail([
          {
            path: 'noteDate',
            code: 'BEFORE_INVOICE',
            message: 'A nota não pode ser anterior à factura.',
          },
        ])
      const c = await computeNote(scope, n.kind, inv, await storedLines(scope, id), n.return_id, id)
      await writeNoteLines(scope, id, c)
      const seriesId = await noteSeries(scope, n, input.seriesId)
      const no = await allocateFiscalNumber(scope, {
        seriesId,
        legalEntityId: n.legal_entity_id,
        documentKind: n.kind === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
        issueDate: n.ndate,
        documentType: 'SALES_NOTE',
        documentId: id,
      })
      const tot = c.taxes.totals
      const payable = dbScaled(tot.payable, 2)
      const content = {
        number: no.formatted,
        kind: n.kind,
        series: no.seriesId,
        mode: no.mode,
        invoice: inv.i.number,
        reason: { code: n.reason_code, text: n.reason },
        customer: { versionId: n.customer_version_id, data: n.customer_snapshot },
        date: n.ndate,
        currency: String(n.currency).trim(),
        exchangeRate: String(n.exchange_rate),
        lines: c.lines.map((x, k) => ({
          n: k + 1,
          invoiceLine: x.original.line_no,
          mode: x.input.mode,
          quantity: x.input.quantity === null ? null : scaledText(x.input.quantity, QTY_SCALE),
          net: scaledText(x.net, 2),
          taxes: c.taxes.lines[k].taxes,
        })),
        totals: tot,
      }
      const fields: Record<string, unknown> = {
        status: 'ISSUED',
        fiscal_status: 'PENDING',
        series_id: no.seriesId,
        fiscal_number: no.number,
        number: no.formatted,
        document_hash: documentHash(content),
        issued_by: context.userId,
        issued_at: new Date(),
      }
      let applied = 0n
      if (n.kind === 'CREDIT') {
        applied = payable < inv.open ? payable : inv.open > 0n ? inv.open : 0n
        await adjustInvoice(scope, n.invoice_id, { credit: applied, note: no.formatted })
        fields.applied_total = scaledText(applied, 2)
      } else await adjustInvoice(scope, n.invoice_id, { debit: payable, note: no.formatted })
      await setNote(scope, id, fields)
      await enqueueFiscalDocument(scope, { documentType: 'SALES_NOTE', documentId: id })
      if (n.return_id && inv.i.order_id)
        await recordReturnCredit(
          scope,
          inv.i.order_id,
          c.lines
            .filter((x) => x.input.mode === 'QUANTITY' && x.original.order_line_id)
            .map((x) => ({ orderLineId: x.original.order_line_id, quantity: x.input.quantity! }))
        )
      if (applied > 0n)
        await scope.trx.rawQuery(
          `insert into sales_note_applications (tenant_id, note_id, invoice_id, amount, created_by, updated_by) values (?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            id,
            n.invoice_id,
            scaledText(applied, 2),
            context.userId,
            context.userId,
          ] as never[]
        )
      await audit(scope, {
        action: 'sales_note.issued',
        entityType: 'sales_note',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'ISSUED' } },
        metadata: {
          number: no.formatted,
          mode: no.mode,
          invoice: inv.i.number,
          payable: tot.payable,
          applied: scaledText(applied, 2),
        },
      })
      return detail(scope, id)
    })
  }

  discard(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { n } = await authorized(scope, id, 'manage', true)
      versionCheck(n, input.expectedVersion)
      if (n.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se descarta um rascunho.')
      const reason = reasonOf(input.reason)
      await setNote(scope, id, { status: 'DISCARDED', discard_reason: reason })
      await audit(scope, {
        action: 'sales_note.discarded',
        entityType: 'sales_note',
        entityId: id,
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }

  /** Usar o crédito disponível noutra factura do mesmo cliente, entidade e moeda (compensação; nunca acima). */
  applyCredit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { n } = await authorized(scope, id, 'manage', true)
      versionCheck(n, input.expectedVersion)
      if (n.kind !== 'CREDIT' || n.status !== 'ISSUED')
        throw ApiError.conflict('INVALID_STATE', 'Só o crédito de uma nota de crédito emitida.')
      const amount = parseScaled(input.amount, 2)
      if (amount === null || amount === 0n)
        fail([{ path: 'amount', code: 'INVALID', message: 'Valor maior que 0, 2 casas.' }])
      const free = available(n) - (await pendingRefunds(scope, id))
      if (amount! > free)
        throw new ApiError(
          409,
          'OVER_CREDIT',
          `A nota só tem ${scaledText(free > 0n ? free : 0n, 2)} de crédito disponível.`,
          [
            {
              path: 'amount',
              code: 'OVER_CREDIT',
              message: `Disponível: ${scaledText(free > 0n ? free : 0n, 2)}.`,
            },
          ]
        )
      const inv = await invoiceForPayment(scope, input.invoiceId as string)
      if (!inv || inv.legalEntityId !== n.legal_entity_id || inv.customerId !== n.customer_id)
        fail([
          {
            path: 'invoiceId',
            code: 'NOT_FOUND',
            message: 'Factura inexistente para este cliente e entidade.',
          },
        ])
      if (inv!.currency !== String(n.currency).trim())
        fail([{ path: 'invoiceId', code: 'CURRENCY_MISMATCH', message: 'Factura noutra moeda.' }])
      await applyInvoicePayment(scope, inv!.id, scaledText(amount!, 2))
      await scope.trx.rawQuery(
        `insert into sales_note_applications (tenant_id, note_id, invoice_id, amount, created_by, updated_by) values (?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          id,
          inv!.id,
          scaledText(amount!, 2),
          context.userId,
          context.userId,
        ] as never[]
      )
      await setNote(scope, id, { applied_total: scaledText(cents(n.applied_total) + amount!, 2) })
      await audit(scope, {
        action: 'sales_note.credit_applied',
        entityType: 'sales_note',
        entityId: id,
        metadata: { invoice: inv!.number, amount: scaledText(amount!, 2) },
      })
      return detail(scope, id)
    })
  }

  /** Registar um reembolso do crédito disponível (pendente da confirmação financeira), idempotente pela chave. */
  registerRefund(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { n } = await authorized(scope, id, 'pay', true)
      const issues: ErrorDetail[] = []
      const amount = parseScaled(input.amount, 2)
      if (amount === null || amount === 0n)
        issues.push({ path: 'amount', code: 'INVALID', message: 'Valor maior que 0, 2 casas.' })
      if (!(METHODS as readonly unknown[]).includes(input.method))
        issues.push({ path: 'method', code: 'INVALID', message: 'Meio inválido.' })
      const date = input.refundDate
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        issues.push({ path: 'refundDate', code: 'INVALID', message: 'Data obrigatória.' })
      else if (date > today())
        issues.push({ path: 'refundDate', code: 'FUTURE', message: 'Não pode ser futura.' })
      const key = typeof input.requestKey === 'string' ? input.requestKey.trim() : ''
      if (!/^[A-Za-z0-9:._-]{8,80}$/.test(key))
        issues.push({
          path: 'requestKey',
          code: 'INVALID',
          message: 'Chave do pedido (8 a 80 caracteres).',
        })
      const reference =
        typeof input.reference === 'string' && input.reference.trim()
          ? input.reference.trim()
          : null
      if (reference && reference.length > 80)
        issues.push({ path: 'reference', code: 'LENGTH', message: 'Até 80 caracteres.' })
      if (['TRANSFER', 'CARD', 'CHEQUE'].includes(input.method as string) && !reference)
        issues.push({
          path: 'reference',
          code: 'REQUIRED',
          message: 'Indique a referência do movimento.',
        })
      const bank = input.bankAccountId ? String(input.bankAccountId) : null
      if (input.method === 'TRANSFER' && !bank)
        issues.push({
          path: 'bankAccountId',
          code: 'REQUIRED',
          message: 'Indique a conta que paga.',
        })
      if (bank) {
        const b = isUuid(bank)
          ? ((
              await scope.trx.rawQuery(
                `select legal_entity_id, status, currency from bank_accounts where tenant_id = ? and id = ?`,
                [context.tenantId, bank]
              )
            ).rows[0] as any)
          : null
        if (!b || b.legal_entity_id !== n.legal_entity_id || b.status !== 'ACTIVE')
          issues.push({
            path: 'bankAccountId',
            code: 'NOT_FOUND',
            message: 'Conta activa da entidade.',
          })
      }
      fail(issues)
      const hash = createHash('sha256')
        .update(JSON.stringify([scaledText(amount!, 2), input.method, bank, reference, date]))
        .digest('hex')
      const prev = (
        await scope.trx.rawQuery(
          `select id, request_hash from sales_refunds where tenant_id = ? and note_id = ? and request_key = ?`,
          [context.tenantId, id, key]
        )
      ).rows[0] as any
      if (prev) {
        if (prev.request_hash !== hash)
          throw ApiError.conflict(
            'IDEMPOTENCY_MISMATCH',
            'Esta chave já foi usada num reembolso diferente.'
          )
        return detail(scope, id)
      }
      if (n.kind !== 'CREDIT' || n.status !== 'ISSUED')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se reembolsa o crédito de uma nota de crédito emitida.'
        )
      const free = available(n) - (await pendingRefunds(scope, id))
      if (amount! > free)
        throw new ApiError(
          409,
          'OVER_REFUND',
          `Só há ${scaledText(free > 0n ? free : 0n, 2)} de crédito por reembolsar.`,
          [
            {
              path: 'amount',
              code: 'OVER_REFUND',
              message: `Disponível: ${scaledText(free > 0n ? free : 0n, 2)}.`,
            },
          ]
        )
      const ins = await scope.trx.rawQuery(
        `insert into sales_refunds (tenant_id, note_id, legal_entity_id, customer_id, currency, amount, method, bank_account_id,
           reference, refund_date, request_key, request_hash, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          id,
          n.legal_entity_id,
          n.customer_id,
          String(n.currency).trim(),
          scaledText(amount!, 2),
          input.method,
          bank,
          reference,
          date,
          key,
          hash,
          context.userId,
          context.userId,
        ] as never[]
      )
      await audit(scope, {
        action: 'sales_refund.registered',
        entityType: 'sales_note',
        entityId: id,
        metadata: {
          refundId: (ins.rows[0] as any).id,
          amount: scaledText(amount!, 2),
          method: input.method,
        },
      })
      return detail(scope, id)
    })
  }

  /** Decidir um reembolso: confirmar (outra pessoa; só então conta), recusar ou anular (com motivo). */
  decideRefund(
    context: TenantContext,
    refundId: string,
    input: Record<string, unknown>,
    action: 'confirm' | 'reject' | 'cancel'
  ) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(refundId)) throw ApiError.notFound()
      const f = (
        await scope.trx.rawQuery(
          `select * from sales_refunds where tenant_id = ? and id = ? for update`,
          [context.tenantId, refundId]
        )
      ).rows[0] as any
      if (!f) throw ApiError.notFound()
      const { n } = await authorized(
        scope,
        f.note_id,
        action === 'cancel' ? 'pay' : 'confirm',
        true
      )
      if (f.status !== 'PENDING')
        throw ApiError.conflict('INVALID_STATE', 'Só um reembolso pendente.')
      versionCheck(f, input.expectedVersion)
      const fields: Record<string, unknown> = {}
      if (action === 'confirm') {
        if (f.created_by === context.userId)
          throw ApiError.forbidden('SELF_CONFIRMATION', 'Quem registou o reembolso não o confirma.')
        const free = available(n)
        if (cents(f.amount) > free)
          throw ApiError.conflict('OVER_REFUND', `A nota só tem ${scaledText(free, 2)} de crédito.`)
        await setNote(scope, n.id, {
          refunded_total: scaledText(cents(n.refunded_total) + cents(f.amount), 2),
        })
        Object.assign(fields, {
          status: 'CONFIRMED',
          confirmed_by: context.userId,
          confirmed_at: new Date(),
        })
      } else
        Object.assign(fields, {
          status: action === 'reject' ? 'REJECTED' : 'CANCELLED',
          decision_reason: reasonOf(input.reason),
        })
      const cols = Object.keys(fields)
      await scope.trx.rawQuery(
        `update sales_refunds set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
          where tenant_id = ? and id = ?`,
        [...cols.map((c) => fields[c]), context.userId, context.tenantId, refundId] as never[]
      )
      await audit(scope, {
        action: `sales_refund.${action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : 'cancelled'}`,
        entityType: 'sales_note',
        entityId: n.id,
        changes: { status: { from: 'PENDING', to: fields.status } },
        metadata: {
          refundId,
          amount: money(f.amount),
          reason: fields.decision_reason ?? undefined,
        },
      })
      return detail(scope, n.id)
    })
  }
}

export { REFUND_STATUSES }

/** Acesso aos anexos da nota. */
export async function noteAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const n = (
    await scope.trx.rawQuery(
      `select legal_entity_id from sales_notes where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!n) return null
  const g = rights(await scopesOf(scope), n.legal_entity_id)
  return g.read ? { read: true, write: g.manage || g.issue } : null
}
