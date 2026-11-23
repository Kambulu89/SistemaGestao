import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import {
  money,
  parseScaled,
  scaledText,
  toFunctional,
} from '#modules/procurement/domain/requisitions'
import { invoiceStatus as orderInvoiceStatus } from '#modules/procurement/domain/orders'
import { invoiceNumberKey, isDate } from '#modules/procurement/domain/invoices'
import {
  creditAmounts,
  CREDIT_NOTE_SERIES_TYPE,
  CREDIT_NOTE_STATUSES,
  type CreditKind,
  type CreditNoteStatus,
  creditStatusOf,
  normalizeCreditLines,
} from '#modules/procurement/domain/returns'
import { tolerancesOf } from '#modules/procurement/application/invoice_service'
import { onCreditNoteValidated } from '#modules/procurement/application/finance_service'

/*
 * Notas de crédito de fornecedor (9.9). Mesmas permissões das facturas (`procurement.invoices.read|manage`, por
 * entidade legal). Parte de uma factura validada (opcionalmente de uma devolução): por linha da factura, quantidade
 * devolvida ao preço da factura ou ajuste de valor, nunca acima do facturado ainda por creditar. A validação, com a
 * factura e a ordem bloqueadas, recalcula com os números do momento, dá o número da série `PURCHASE_CREDIT_NOTE`,
 * abate a quantidade facturada da ordem e o crédito pendente das devoluções; fica ao câmbio da factura. A obrigação
 * a pagar (factura − notas de crédito) e a contabilização são do 9.10.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const c2 = (v: unknown) => parseScaled(String(v ?? '0'), 2) ?? 0n
const r3 = (v: unknown) => parseScaled(String(v ?? '0'), 3) ?? 0n
const r10 = (v: unknown) => parseScaled(String(v ?? '0'), 10) ?? 0n
const t6 = (v: bigint) => scaledText(v, 6)
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
}
async function scopesOf(scope: TenantScope): Promise<Scopes> {
  return {
    read: await permissionScope(scope, 'procurement.invoices.read'),
    manage: await permissionScope(scope, 'procurement.invoices.manage'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
const rights = (s: Scopes, le: string) => {
  const manage = covers(s.manage, le)
  return { read: manage || covers(s.read, le), manage }
}
const anyLe = (s: Scopes) =>
  s.read.tenant || s.manage.tenant
    ? 'ALL'
    : [...new Set([...s.read.legalEntityIds, ...s.manage.legalEntityIds])]

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const c = (
    await scope.trx.rawQuery(
      `select * from purchase_credit_notes where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!c) throw ApiError.notFound()
  return c
}

async function authorized(scope: TenantScope, id: string, need: 'read' | 'manage', lock = false) {
  const c = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), c.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (need === 'manage' && !g.manage)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista notas de crédito desta entidade.')
  return { c, g }
}

const versionCheck = (x: any, expected: unknown) => {
  if (Number(x.version) !== Number(expected)) throw ApiError.versionConflict(Number(x.version))
}

async function event(
  scope: TenantScope,
  id: string,
  kind: string,
  e: { reason?: string | null; details?: Record<string, unknown> } = {}
) {
  await scope.trx.rawQuery(
    `insert into purchase_credit_note_events (tenant_id, credit_note_id, kind, reason, details, created_by, updated_by)
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

async function setNote(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update purchase_credit_notes set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function loadInvoice(scope: TenantScope, invoiceId: string, lock = false) {
  if (!isUuid(invoiceId))
    fail([{ path: 'invoiceId', code: 'REQUIRED', message: 'Factura do fornecedor.' }])
  const i = (
    await scope.trx.rawQuery(
      `select i.*, o.number as order_number, bp.code as sup_code, bp.name as sup_name from purchase_invoices i
         join purchase_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
         join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where i.tenant_id = ? and i.id = ?${lock ? ' for update of i' : ''}`,
      [scope.context.tenantId, invoiceId]
    )
  ).rows[0] as any
  if (!i) throw ApiError.notFound()
  return i
}

/** Linhas da factura com o já creditado por notas validadas (excepto a indicada). */
async function invoiceLines(scope: TenantScope, invoiceId: string, exceptNoteId: string | null) {
  return (
    (
      await scope.trx.rawQuery(
        `select l.*, ol.line_no as order_line_no, ol.uom_code,
            coalesce(cr.q, 0)::text as credited_quantity, coalesce(cr.n, 0)::text as credited_net,
            coalesce(cr.t, 0)::text as credited_tax
           from purchase_invoice_lines l
           left join purchase_order_lines ol on ol.tenant_id = l.tenant_id and ol.id = l.order_line_id
           left join lateral (
             select sum(x.quantity) as q, sum(x.net_amount) as n, sum(x.tax_amount) as t
               from purchase_credit_note_lines x join purchase_credit_notes c
                 on c.tenant_id = x.tenant_id and c.id = x.credit_note_id
              where x.tenant_id = l.tenant_id and x.invoice_line_id = l.id and c.status = 'VALIDATED'
                and c.id is distinct from ?::uuid) cr on true
          where l.tenant_id = ? and l.invoice_id = ? order by l.line_no`,
        [exceptNoteId, scope.context.tenantId, invoiceId] as never[]
      )
    ).rows as any[]
  ).map((l) => ({
    ...l,
    before: {
      quantity: q6(l.credited_quantity),
      net: c2(l.credited_net),
      tax: c2(l.credited_tax),
    },
  }))
}

/** Linhas de devolução confirmadas da ordem com crédito pendente. */
async function pendingReturnLines(scope: TenantScope, orderId: string, lock = false) {
  return (
    await scope.trx.rawQuery(
      `select l.*, r.number as return_number, r.id as return_id from purchase_return_lines l
         join purchase_returns r on r.tenant_id = l.tenant_id and r.id = l.return_id
        where l.tenant_id = ? and r.order_id = ? and r.status = 'CONFIRMED'
          and l.credit_quantity > l.credited_quantity order by r.number, l.line_no${lock ? ' for update of l' : ''}`,
      [scope.context.tenantId, orderId]
    )
  ).rows as any[]
}

/** Cabeçalho e linhas calculadas contra a factura (o que ainda se pode creditar). */
async function prepare(
  scope: TenantScope,
  inv: any,
  input: Record<string, unknown>,
  exceptNoteId: string | null,
  lockReturns = false
) {
  const issues: ErrorDetail[] = []
  const number = text(input.creditNoteNumber)
  if (!number || number.length > 60)
    issues.push({
      path: 'creditNoteNumber',
      code: 'REQUIRED',
      message: 'Número da nota de crédito do fornecedor (até 60).',
    })
  const date = input.creditNoteDate === undefined ? today() : input.creditNoteDate
  if (!isDate(date))
    issues.push({ path: 'creditNoteDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  else if ((date as string) > today())
    issues.push({ path: 'creditNoteDate', code: 'FUTURE', message: 'Sem datas futuras.' })
  else if ((date as string) < isoDate(inv.invoice_date)!)
    issues.push({
      path: 'creditNoteDate',
      code: 'BEFORE_INVOICE',
      message: 'A nota de crédito não pode ser anterior à factura.',
    })
  const reason = text(input.reason)
  if (reason.length < 3 || reason.length > 500)
    issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' })
  const declared = parseScaled(input.declaredTotal, 2)
  if (declared === null || declared <= 0n)
    issues.push({
      path: 'declaredTotal',
      code: 'INVALID',
      message: 'Total da nota de crédito maior que zero, até 2 casas.',
    })
  let returnId: string | null = null
  if (input.returnId !== undefined && input.returnId !== null && input.returnId !== '') {
    const r = isUuid(input.returnId)
      ? ((
          await scope.trx.rawQuery(
            `select id, order_id, status from purchase_returns where tenant_id = ? and id = ?`,
            [scope.context.tenantId, input.returnId]
          )
        ).rows[0] as any)
      : null
    if (!r || r.order_id !== inv.order_id || r.status !== 'CONFIRMED')
      issues.push({
        path: 'returnId',
        code: 'NOT_FOUND',
        message: 'Devolução confirmada da mesma ordem.',
      })
    else returnId = r.id
  }
  const norm = normalizeCreditLines(input.lines)
  issues.push(...norm.issues)
  const ils = new Map(
    (await invoiceLines(scope, inv.id, exceptNoteId)).map((l) => [l.id as string, l])
  )
  const rls = new Map(
    (await pendingReturnLines(scope, inv.order_id, lockReturns)).map((l) => [l.id as string, l])
  )
  // Acumula dentro da própria nota (a mesma linha da factura pode aparecer duas vezes: quantidade e valor).
  const used = new Map<string, { quantity: bigint; net: bigint; tax: bigint }>()
  const usedReturn = new Map<string, bigint>()
  const rows = norm.lines.map((l, i) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${f}`, code, message })
    const il = ils.get(l.invoiceLineId)
    if (!il) {
      if (l.invoiceLineId) at('invoiceLineId', 'NOT_FOUND', 'Linha que não é desta factura.')
      return null
    }
    if (l.kind === 'QUANTITY' && !il.order_line_id)
      at('kind', 'NOT_ALLOWED', 'Um encargo sem linha da ordem só se credita em valor.')
    const prev = used.get(il.id) ?? il.before
    const invoice = {
      quantity: q6(il.quantity),
      net: c2(il.net_amount),
      tax: c2(il.tax_amount),
      taxRate: r3(il.tax_rate),
    }
    if (l.kind === 'QUANTITY' && prev.quantity + l.quantity > invoice.quantity)
      at(
        'quantity',
        'OVER_INVOICED',
        `Linha ${il.line_no}: só ${t6(invoice.quantity - prev.quantity)} facturado por creditar.`
      )
    const a = creditAmounts({
      kind: l.kind,
      quantity: l.quantity,
      netAmount: l.netAmount,
      invoice,
      before: prev,
    })
    if (a.net <= 0n || prev.net + a.net > invoice.net)
      at(
        l.kind === 'QUANTITY' ? 'quantity' : 'netAmount',
        'OVER_INVOICED',
        `Linha ${il.line_no}: só ${money(invoice.net - prev.net)} de valor por creditar.`
      )
    if (l.returnLineId) {
      const rl = rls.get(l.returnLineId)
      if (!rl || rl.order_line_id !== il.order_line_id || (returnId && rl.return_id !== returnId))
        at('returnLineId', 'NOT_FOUND', 'Linha de devolução com crédito pendente desta linha.')
      else {
        const left = q6(rl.credit_quantity) - q6(rl.credited_quantity)
        const take = (usedReturn.get(rl.id) ?? 0n) + l.quantity
        if (take > left)
          at(
            'quantity',
            'OVER_PENDING',
            `A devolução ${rl.return_number} só tem ${t6(left)} por creditar nesta linha.`
          )
        usedReturn.set(rl.id, take)
      }
    }
    used.set(il.id, {
      quantity: prev.quantity + (l.kind === 'QUANTITY' ? l.quantity : 0n),
      net: prev.net + a.net,
      tax: prev.tax + a.tax,
    })
    return { ...l, il, ...a }
  })
  const totalNet = rows.reduce((s, x) => s + (x?.net ?? 0n), 0n)
  const totalTax = rows.reduce((s, x) => s + (x?.tax ?? 0n), 0n)
  const total = totalNet + totalTax
  if (declared !== null && declared > 0n && !issues.length) {
    const tol = await tolerancesOf(scope)
    const diff = declared > total ? declared - total : total - declared
    if (diff > tol.totalAmount)
      issues.push({
        path: 'declaredTotal',
        code: 'TOTAL_MISMATCH',
        message: `O total declarado (${money(declared)}) difere do calculado pela factura (${money(total)}).`,
      })
  }
  fail(issues)
  return {
    number,
    key: invoiceNumberKey(number),
    date: date as string,
    reason,
    declared: declared!,
    returnId,
    rows: rows as NonNullable<(typeof rows)[number]>[],
    totalNet,
    totalTax,
    total,
  }
}

async function duplicateOf(
  scope: TenantScope,
  supplierId: string,
  key: string,
  exceptId: string | null
) {
  return (
    await scope.trx.rawQuery(
      `select id, number, credit_note_number from purchase_credit_notes where tenant_id = ? and supplier_id = ?
          and credit_note_number_key = ? and status <> 'CANCELLED' and id is distinct from ?::uuid limit 1`,
      [scope.context.tenantId, supplierId, key, exceptId] as never[]
    )
  ).rows[0] as any
}
const duplicateError = (d: any) =>
  new ApiError(
    409,
    'DUPLICATE_CREDIT_NOTE',
    `Esta nota de crédito do fornecedor já está registada (${d.number ?? d.credit_note_number}).`,
    [{ path: 'creditNoteNumber', code: 'DUPLICATE', message: d.id }]
  )

async function writeLines(scope: TenantScope, id: string, rows: any[]) {
  const t = scope.context.tenantId
  const u = scope.context.userId
  await scope.trx.rawQuery(
    `delete from purchase_credit_note_lines where tenant_id = ? and credit_note_id = ?`,
    [t, id]
  )
  for (const [i, x] of rows.entries())
    await scope.trx.rawQuery(
      `insert into purchase_credit_note_lines (tenant_id, credit_note_id, line_no, invoice_line_id, order_line_id,
          return_line_id, kind, quantity, net_amount, tax_rate, tax_amount, total_amount, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        id,
        i + 1,
        x.il.id,
        x.kind === 'QUANTITY' ? x.il.order_line_id : null,
        x.returnLineId,
        x.kind,
        t6(x.kind === 'QUANTITY' ? x.quantity : 0n),
        money(x.net),
        scaledText(r3(x.il.tax_rate), 3),
        money(x.tax),
        money(x.total),
        u,
        u,
      ] as never[]
    )
}

async function detail(scope: TenantScope, id: string) {
  const { c, g } = await authorized(scope, id, 'read')
  const t = scope.context.tenantId
  const info = (
    await scope.trx.rawQuery(
      `select i.number as invoice_number_internal, i.invoice_number, o.number as order_number, r.number as return_number,
          le.code as le_code, bp.code as sup_code, bp.name as sup_name, uv.full_name as validated_name
         from purchase_credit_notes c join purchase_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
         join purchase_orders o on o.tenant_id = c.tenant_id and o.id = c.order_id
         left join purchase_returns r on r.tenant_id = c.tenant_id and r.id = c.return_id
         join legal_entities le on le.tenant_id = c.tenant_id and le.id = c.legal_entity_id
         join suppliers s on s.tenant_id = c.tenant_id and s.id = c.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
         left join users uv on uv.id = c.validated_by
        where c.tenant_id = ? and c.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  const lines = (
    await scope.trx.rawQuery(
      `select x.*, il.line_no as invoice_line_no, il.description, il.quantity as invoiced_quantity,
          ol.uom_code, r.number as return_number
         from purchase_credit_note_lines x
         join purchase_invoice_lines il on il.tenant_id = x.tenant_id and il.id = x.invoice_line_id
         left join purchase_order_lines ol on ol.tenant_id = il.tenant_id and ol.id = il.order_line_id
         left join purchase_return_lines rl on rl.tenant_id = x.tenant_id and rl.id = x.return_line_id
         left join purchase_returns r on r.tenant_id = rl.tenant_id and r.id = rl.return_id
        where x.tenant_id = ? and x.credit_note_id = ? order by x.line_no`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from purchase_credit_note_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.credit_note_id = ? order by e.created_at desc, e.id`,
      [t, id]
    )
  ).rows as any[]
  const status = c.status as CreditNoteStatus
  return {
    id: c.id as string,
    version: Number(c.version),
    number: (c.number as string) ?? null,
    status,
    legalEntity: { id: c.legal_entity_id as string, code: info.le_code as string },
    supplier: {
      id: c.supplier_id as string,
      code: info.sup_code as string,
      name: info.sup_name as string,
    },
    order: { id: c.order_id as string, number: info.order_number as string },
    invoice: {
      id: c.invoice_id as string,
      number: info.invoice_number_internal as string,
      invoiceNumber: info.invoice_number as string,
    },
    return: c.return_id
      ? { id: c.return_id as string, number: info.return_number as string }
      : null,
    creditNoteNumber: c.credit_note_number as string,
    creditNoteDate: isoDate(c.credit_note_date)!,
    currency: c.currency as string,
    reason: c.reason as string,
    declaredTotal: money(c2(c.declared_total)),
    totalNet: money(c2(c.total_net)),
    totalTax: money(c2(c.total_tax)),
    totalAmount: money(c2(c.total_amount)),
    exchangeRate: scaledText(r10(c.exchange_rate), 10),
    totalFunctional: c.total_functional === null ? null : money(c2(c.total_functional)),
    validatedAt: c.validated_at ? new Date(c.validated_at).toISOString() : null,
    validatedBy: (info.validated_name as string) ?? null,
    cancelReason: (c.cancel_reason as string) ?? null,
    lines: lines.map((l) => ({
      id: l.id as string,
      lineNo: Number(l.line_no),
      invoiceLineId: l.invoice_line_id as string,
      invoiceLineNo: Number(l.invoice_line_no),
      description: l.description as string,
      uom: (l.uom_code as string) ?? null,
      kind: l.kind as CreditKind,
      quantity: t6(q6(l.quantity)),
      invoicedQuantity: t6(q6(l.invoiced_quantity)),
      returnLineId: (l.return_line_id as string) ?? null,
      returnNumber: (l.return_number as string) ?? null,
      netAmount: money(c2(l.net_amount)),
      taxRate: scaledText(r3(l.tax_rate), 3),
      taxAmount: money(c2(l.tax_amount)),
      totalAmount: money(c2(l.total_amount)),
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
      cancel: g.manage && status === 'DRAFT',
    },
  }
}

export type CreditNoteDetail = Awaited<ReturnType<typeof detail>>

export class CreditNoteService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      invoiceId?: string
      returnId?: string
      supplierId?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const les = anyLe(await scopesOf(scope))
      if (les !== 'ALL' && !les.length) return { items: [], total: 0 }
      const where = ['c.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (les !== 'ALL') {
        where.push('c.legal_entity_id = any(?::uuid[])')
        params.push(les)
      }
      if (f.status && (CREDIT_NOTE_STATUSES as readonly string[]).includes(f.status)) {
        where.push('c.status = ?')
        params.push(f.status)
      }
      for (const [k, col] of [
        ['invoiceId', 'c.invoice_id'],
        ['returnId', 'c.return_id'],
        ['supplierId', 'c.supplier_id'],
      ] as const)
        if (f[k] && isUuid(f[k])) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(c.number, '')) like ? or lower(c.credit_note_number) like ? or lower(bp.name) like ?
             or lower(i.invoice_number) like ?)`
        )
        params.push(like, like, like, like)
      }
      const from = `from purchase_credit_notes c join purchase_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
        join suppliers s on s.tenant_id = c.tenant_id and s.id = c.supplier_id
        join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select c.*, i.number as invoice_internal, i.invoice_number, bp.code as sup_code, bp.name as sup_name
             ${from} order by c.created_at desc, c.id limit ? offset ?`,
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
        items: rows.map((c) => ({
          id: c.id as string,
          number: (c.number as string) ?? null,
          status: c.status as CreditNoteStatus,
          creditNoteNumber: c.credit_note_number as string,
          creditNoteDate: isoDate(c.credit_note_date)!,
          supplier: {
            id: c.supplier_id as string,
            code: c.sup_code as string,
            name: c.sup_name as string,
          },
          invoice: {
            id: c.invoice_id as string,
            number: c.invoice_internal as string,
            invoiceNumber: c.invoice_number as string,
          },
          currency: c.currency as string,
          totalAmount: money(c2(c.total_amount)),
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  /** O que uma factura tem por creditar (para o formulário), com as devoluções com crédito pendente da ordem. */
  creditableInvoice(context: TenantContext, invoiceId: string, exceptNoteId: string | null) {
    return runInTenant(context, async (scope) => {
      const inv = await loadInvoice(scope, invoiceId)
      const g = rights(await scopesOf(scope), inv.legal_entity_id)
      if (!g.read) throw ApiError.notFound()
      const ils = await invoiceLines(
        scope,
        inv.id,
        exceptNoteId && isUuid(exceptNoteId) ? exceptNoteId : null
      )
      const pending = await pendingReturnLines(scope, inv.order_id)
      return {
        id: inv.id as string,
        number: (inv.number as string) ?? null,
        invoiceNumber: inv.invoice_number as string,
        invoiceDate: isoDate(inv.invoice_date)!,
        creditable: inv.status === 'VALIDATED',
        currency: inv.currency as string,
        order: { id: inv.order_id as string, number: inv.order_number as string },
        supplier: {
          id: inv.supplier_id as string,
          code: inv.sup_code as string,
          name: inv.sup_name as string,
        },
        totalAmount: money(c2(inv.total_amount)),
        lines: ils.map((l) => ({
          id: l.id as string,
          lineNo: Number(l.line_no),
          orderLineId: (l.order_line_id as string) ?? null,
          orderLineNo: l.order_line_no === null ? null : Number(l.order_line_no),
          description: l.description as string,
          uom: (l.uom_code as string) ?? null,
          quantity: t6(q6(l.quantity)),
          netAmount: money(c2(l.net_amount)),
          taxRate: scaledText(r3(l.tax_rate), 3),
          taxAmount: money(c2(l.tax_amount)),
          creditedQuantity: t6(l.before.quantity),
          creditedNet: money(l.before.net),
          quantityLeft: t6(q6(l.quantity) - l.before.quantity),
          netLeft: money(c2(l.net_amount) - l.before.net),
          taxLeft: money(c2(l.tax_amount) - l.before.tax),
        })),
        pendingReturns: pending.map((r) => ({
          returnId: r.return_id as string,
          returnNumber: r.return_number as string,
          returnLineId: r.id as string,
          orderLineId: r.order_line_id as string,
          pending: t6(q6(r.credit_quantity) - q6(r.credited_quantity)),
        })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const inv = await loadInvoice(scope, input.invoiceId as string)
      const g = rights(await scopesOf(scope), inv.legal_entity_id)
      if (!g.read) throw ApiError.notFound()
      if (!g.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista notas de crédito desta entidade.')
      if (inv.status !== 'VALIDATED')
        throw ApiError.conflict('NOT_CREDITABLE', 'Só se credita uma factura validada.')
      // Duplicado primeiro: a mesma nota do fornecedor é recusada sem precisar do resto.
      const early = text(input.creditNoteNumber)
      const known = early
        ? await duplicateOf(scope, inv.supplier_id, invoiceNumberKey(early), null)
        : null
      if (known) throw duplicateError(known)
      const p = await prepare(scope, inv, input, null)
      const ins = await scope.trx.rawQuery(
        `insert into purchase_credit_notes (tenant_id, legal_entity_id, supplier_id, order_id, invoice_id, return_id,
            credit_note_number, credit_note_number_key, credit_note_date, currency, reason, declared_total, total_net,
            total_tax, total_amount, exchange_rate, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          inv.legal_entity_id,
          inv.supplier_id,
          inv.order_id,
          inv.id,
          p.returnId,
          p.number,
          p.key,
          p.date,
          inv.currency,
          p.reason,
          money(p.declared),
          money(p.totalNet),
          money(p.totalTax),
          money(p.total),
          inv.exchange_rate,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await writeLines(scope, id, p.rows)
      await event(scope, id, 'CREATED')
      await audit(scope, {
        action: 'purchase_credit_note.created',
        entityType: 'purchase_credit_note',
        entityId: id,
        changes: {
          invoiceId: { from: null, to: inv.id },
          total: { from: null, to: money(p.total) },
        },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      if (c.status !== 'DRAFT') throw ApiError.conflict('INVALID_STATE', 'Só se altera o rascunho.')
      const inv = await loadInvoice(scope, c.invoice_id)
      const merged: Record<string, unknown> = { returnId: c.return_id, ...input }
      const early = text(merged.creditNoteNumber)
      const known = early
        ? await duplicateOf(scope, inv.supplier_id, invoiceNumberKey(early), id)
        : null
      if (known) throw duplicateError(known)
      const p = await prepare(scope, inv, merged, id)
      await writeLines(scope, id, p.rows)
      await setNote(scope, id, {
        return_id: p.returnId,
        credit_note_number: p.number,
        credit_note_number_key: p.key,
        credit_note_date: p.date,
        reason: p.reason,
        declared_total: money(p.declared),
        total_net: money(p.totalNet),
        total_tax: money(p.totalTax),
        total_amount: money(p.total),
      })
      await event(scope, id, 'UPDATED')
      return detail(scope, id)
    })
  }

  /**
   * Validar: com a factura, as linhas da ordem e as devoluções bloqueadas, recalcula contra o que já foi creditado no
   * momento (outra nota pode ter sido validada entretanto), dá o número, abate o facturado da ordem e o crédito
   * pendente das devoluções. Ao câmbio da factura.
   */
  validate(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      if (c.status !== 'DRAFT')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Esta nota de crédito já não está em rascunho (não se valida duas vezes).'
        )
      const t = context.tenantId
      const inv = await loadInvoice(scope, c.invoice_id, true)
      if (inv.status !== 'VALIDATED')
        throw ApiError.conflict('NOT_CREDITABLE', 'A factura deixou de estar validada.')
      const ols = new Map(
        (
          (
            await scope.trx.rawQuery(
              `select * from purchase_order_lines where tenant_id = ? and order_id = ? for update`,
              [t, inv.order_id]
            )
          ).rows as any[]
        ).map((l) => [l.id as string, l])
      )
      const stored = (
        await scope.trx.rawQuery(
          `select * from purchase_credit_note_lines where tenant_id = ? and credit_note_id = ? order by line_no`,
          [t, id]
        )
      ).rows as any[]
      const p = await prepare(
        scope,
        inv,
        {
          creditNoteNumber: c.credit_note_number,
          creditNoteDate: isoDate(c.credit_note_date),
          reason: c.reason,
          declaredTotal: money(c2(c.declared_total)),
          returnId: c.return_id,
          lines: stored.map((x) => ({
            invoiceLineId: x.invoice_line_id,
            kind: x.kind,
            quantity: x.kind === 'QUANTITY' ? t6(q6(x.quantity)) : undefined,
            netAmount: x.kind === 'PRICE' ? money(c2(x.net_amount)) : undefined,
            returnLineId: x.return_line_id,
          })),
        },
        id,
        true
      )
      // Os valores podem ter mudado (a última nota de uma linha leva o resto exacto): grava os do momento.
      await writeLines(scope, id, p.rows)
      const ser = await scope.trx.rawQuery(
        `select id from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ? and status = 'ACTIVE'
            and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
            and branch_id is null order by code limit 1`,
        [t, c.legal_entity_id, CREDIT_NOTE_SERIES_TYPE, today(), today()]
      )
      const series = ser.rows[0] as { id: string } | undefined
      if (!series)
        throw ApiError.conflict(
          'NO_SERIES',
          `Sem série documental ${CREDIT_NOTE_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
        )
      const number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      const returns = new Set<string>()
      for (const x of p.rows) {
        if (x.kind !== 'QUANTITY') continue
        const ol = ols.get(x.il.order_line_id)!
        const next = q6(ol.invoiced_quantity) - x.quantity
        await scope.trx.rawQuery(
          `update purchase_order_lines set invoiced_quantity = ?, updated_at = now(), version = version + 1
            where tenant_id = ? and id = ?`,
          [t6(next < 0n ? 0n : next), t, ol.id] as never[]
        )
        ol.invoiced_quantity = t6(next < 0n ? 0n : next)
        if (x.returnLineId) {
          const rl = (
            await scope.trx.rawQuery(
              `update purchase_return_lines set credited_quantity = credited_quantity + ?::numeric, updated_at = now(),
                  version = version + 1 where tenant_id = ? and id = ? returning return_id`,
              [t6(x.quantity), t, x.returnLineId] as never[]
            )
          ).rows[0] as any
          returns.add(rl.return_id)
        }
      }
      const status = orderInvoiceStatus(
        [...ols.values()].map((l) => ({
          quantity: q6(l.quantity),
          invoiced: q6(l.invoiced_quantity),
          cancelled: q6(l.cancelled_quantity),
        }))
      )
      await scope.trx.rawQuery(
        `update purchase_orders set invoice_status = ?, updated_at = now(), version = version + 1
          where tenant_id = ? and id = ? and invoice_status <> ?`,
        [status, t, inv.order_id, status]
      )
      for (const rid of returns) {
        const rls = (
          await scope.trx.rawQuery(
            `select credit_quantity, credited_quantity from purchase_return_lines where tenant_id = ? and return_id = ?`,
            [t, rid]
          )
        ).rows as any[]
        const cs = creditStatusOf(
          rls.map((x) => ({
            creditQuantity: q6(x.credit_quantity),
            credited: q6(x.credited_quantity),
          }))
        )
        await scope.trx.rawQuery(
          `update purchase_returns set credit_status = ?, updated_by = ?, updated_at = now(), version = version + 1
            where tenant_id = ? and id = ? and credit_status <> ?`,
          [cs, context.userId, t, rid, cs]
        )
      }
      await setNote(scope, id, {
        status: 'VALIDATED',
        series_id: series.id,
        number,
        total_net: money(p.totalNet),
        total_tax: money(p.totalTax),
        total_amount: money(p.total),
        total_functional: money(toFunctional(p.total, r10(c.exchange_rate))),
        validated_at: new Date(),
        validated_by: context.userId,
      })
      // Abate a obrigação, realizado negativo, compromisso da ordem e evento contabilístico (9.10).
      await onCreditNoteValidated(scope, id)
      await event(scope, id, 'VALIDATED', {
        details: { number, total: money(p.total), orderInvoiceStatus: status },
      })
      await audit(scope, {
        action: 'purchase_credit_note.validated',
        entityType: 'purchase_credit_note',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'VALIDATED' }, number: { from: null, to: number } },
      })
      return detail(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, input.expectedVersion)
      if (c.status !== 'DRAFT') throw ApiError.conflict('INVALID_STATE', 'Só se anula o rascunho.')
      const reason = text(input.reason)
      if (!reason || reason.length > 500)
        fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (até 500).' }])
      await setNote(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await event(scope, id, 'CANCELLED', { reason })
      await audit(scope, {
        action: 'purchase_credit_note.cancelled',
        entityType: 'purchase_credit_note',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'CANCELLED' } },
      })
      return detail(scope, id)
    })
  }
}

/** Creditado por linha da factura e notas da factura (para o detalhe da factura). */
export async function invoiceCredits(scope: TenantScope, invoiceId: string) {
  const t = scope.context.tenantId
  const notes = (
    await scope.trx.rawQuery(
      `select id, number, credit_note_number, status, credit_note_date, total_amount from purchase_credit_notes
        where tenant_id = ? and invoice_id = ? order by created_at`,
      [t, invoiceId]
    )
  ).rows as any[]
  const byLine = (
    await scope.trx.rawQuery(
      `select x.invoice_line_id, sum(x.quantity)::text as q, sum(x.total_amount)::text as v
         from purchase_credit_note_lines x join purchase_credit_notes c on c.tenant_id = x.tenant_id and c.id = x.credit_note_id
        where x.tenant_id = ? and c.invoice_id = ? and c.status = 'VALIDATED' group by x.invoice_line_id`,
      [t, invoiceId]
    )
  ).rows as any[]
  const credited = notes
    .filter((n) => n.status === 'VALIDATED')
    .reduce((s, n) => s + c2(n.total_amount), 0n)
  return {
    credited,
    byLine: new Map(
      byLine.map((x) => [
        x.invoice_line_id as string,
        { quantity: t6(q6(x.q)), total: money(c2(x.v)) },
      ])
    ),
    notes: notes.map((n) => ({
      id: n.id as string,
      number: (n.number as string) ?? null,
      creditNoteNumber: n.credit_note_number as string,
      status: n.status as CreditNoteStatus,
      creditNoteDate: isoDate(n.credit_note_date)!,
      totalAmount: money(c2(n.total_amount)),
    })),
  }
}

/** Existe nesta empresa e o membro pode ler (anexos): `null` sem acesso. */
export async function purchaseCreditNoteAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const c = (
    await scope.trx.rawQuery(
      `select legal_entity_id from purchase_credit_notes where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!c) return null
  const g = rights(await scopesOf(scope), c.legal_entity_id)
  return g.read ? { read: true, write: g.manage } : null
}
