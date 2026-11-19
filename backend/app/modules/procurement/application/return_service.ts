import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import { returnToSupplier } from '#modules/inventory/index'
import { divRound, parseScaled, scaledText } from '#modules/procurement/domain/requisitions'
import {
  invoiceStatus as orderInvoiceStatus,
  receiptStatus as orderReceiptStatus,
} from '#modules/procurement/domain/orders'
import {
  cancelOnCredit,
  creditNeed,
  type CreditStatus,
  creditStatusOf,
  normalizeReturnHeader,
  normalizeReturnLines,
  type Remedy,
  RETURN_SERIES_TYPE,
  RETURN_STATUSES,
  returnable,
  type ReturnStatus,
} from '#modules/procurement/domain/returns'

/*
 * Devoluções a fornecedor e não conformidades (9.9). Permissões no âmbito da entidade legal:
 * `procurement.returns.read` e `.manage` (registar, confirmar, anular o rascunho). A devolução parte de uma recepção
 * confirmada; a confirmação exige evidência (pelo menos um anexo), e, com a ordem bloqueada, volta a verificar o que
 * ainda se pode devolver, dá o número, faz **uma** saída no Inventário para os bens armazenáveis aceites
 * (`returnToSupplier`, idempotente pela devolução, valorizada pela recepção de origem) e acerta a ordem: o aceite
 * devolvido deixa de contar como recebido; a crédito, deixa também de ser esperado e o que já estava facturado fica por
 * creditar (nota de crédito). Confirmada, não muda: uma devolução errada corrige-se com nova recepção.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
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
    read: await permissionScope(scope, 'procurement.returns.read'),
    manage: await permissionScope(scope, 'procurement.returns.manage'),
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
  const r = (
    await scope.trx.rawQuery(
      `select * from purchase_returns where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}

async function authorized(scope: TenantScope, id: string, need: 'read' | 'manage', lock = false) {
  const r = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), r.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (need === 'manage' && !g.manage)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista devoluções desta entidade.')
  return { r, g }
}

const versionCheck = (r: any, expected: unknown) => {
  if (Number(r.version) !== Number(expected)) throw ApiError.versionConflict(Number(r.version))
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
    `insert into purchase_return_events (tenant_id, return_id, kind, reason, details, created_by, updated_by)
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

async function setReturn(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update purchase_returns set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/** Recepção de origem (com a ordem e o fornecedor); 404 se não existe nesta empresa. */
async function loadReceipt(scope: TenantScope, receiptId: string) {
  if (!isUuid(receiptId))
    fail([{ path: 'receiptId', code: 'REQUIRED', message: 'Recepção de compra.' }])
  const r = (
    await scope.trx.rawQuery(
      `select r.*, o.number as order_number, o.closed_at as order_closed_at, o.approval_status as order_approval,
          bp.code as sup_code, bp.name as sup_name
         from purchase_receipts r join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
         join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where r.tenant_id = ? and r.id = ?`,
      [scope.context.tenantId, receiptId]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}

/**
 * Linhas da recepção com o que ainda se pode devolver (aceite e recusado), descontando as outras devoluções não
 * anuladas (as em rascunho também reservam, para duas não levarem o mesmo).
 */
async function receiptLines(scope: TenantScope, receiptId: string, exceptReturnId: string | null) {
  const t = scope.context.tenantId
  const rows = (
    await scope.trx.rawQuery(
      `select rl.*, ol.description, ol.uom_code, ol.line_no as order_line_no, p.sku, p.track_lots, p.track_serials,
          bu.code as base_uom_code, wl.path_code,
          coalesce((select sum(x.quantity) from purchase_return_lines x join purchase_returns pr
              on pr.tenant_id = x.tenant_id and pr.id = x.return_id
            where x.tenant_id = rl.tenant_id and x.receipt_line_id = rl.id and x.source = 'ACCEPTED'
              and pr.status <> 'CANCELLED' and pr.id is distinct from ?::uuid), 0)::text as returned_accepted,
          coalesce((select sum(x.quantity) from purchase_return_lines x join purchase_returns pr
              on pr.tenant_id = x.tenant_id and pr.id = x.return_id
            where x.tenant_id = rl.tenant_id and x.receipt_line_id = rl.id and x.source = 'REFUSED'
              and pr.status <> 'CANCELLED' and pr.id is distinct from ?::uuid), 0)::text as returned_refused
         from purchase_receipt_lines rl
         join purchase_order_lines ol on ol.tenant_id = rl.tenant_id and ol.id = rl.order_line_id
         left join products p on p.tenant_id = rl.tenant_id and p.id = rl.product_id
         left join uoms bu on bu.tenant_id = p.tenant_id and bu.id = p.base_uom_id
         left join warehouse_locations wl on wl.tenant_id = rl.tenant_id and wl.id = rl.location_id
        where rl.tenant_id = ? and rl.receipt_id = ? order by rl.line_no`,
      [exceptReturnId, exceptReturnId, t, receiptId] as never[]
    )
  ).rows as any[]
  return rows.map((x) => ({
    ...x,
    acceptedLeft: returnable(q6(x.quantity), q6(x.returned_accepted)),
    refusedLeft: returnable(q6(x.rejected_quantity), q6(x.returned_refused)),
  }))
}

/** Base da devolução na proporção da recepção (unidade da ordem → unidade base). */
const baseOf = (qty: bigint, rl: any) =>
  rl.base_quantity === null || q6(rl.quantity) === 0n
    ? null
    : divRound(qty * q6(rl.base_quantity), q6(rl.quantity))

/** Valida as linhas contra a recepção: pertença, disponível, séries recebidas, localização do armazém. */
async function linesFor(scope: TenantScope, rc: any, raw: unknown, exceptReturnId: string | null) {
  const { lines, issues } = normalizeReturnLines(raw)
  const rls = await receiptLines(scope, rc.id, exceptReturnId)
  const byId = new Map(rls.map((l) => [l.id as string, l]))
  const locs = rc.warehouse_id
    ? new Set(
        (
          (
            await scope.trx.rawQuery(
              `select id from warehouse_locations where tenant_id = ? and warehouse_id = ?`,
              [scope.context.tenantId, rc.warehouse_id]
            )
          ).rows as any[]
        ).map((x) => x.id as string)
      )
    : new Set<string>()
  const out = lines.map((l, i) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${f}`, code, message })
    const rl = byId.get(l.receiptLineId)
    if (!rl) {
      if (l.receiptLineId) at('receiptLineId', 'NOT_FOUND', 'Linha que não é desta recepção.')
      return { ...l, rl: null, stocked: false, base: null as bigint | null }
    }
    const left = l.source === 'ACCEPTED' ? rl.acceptedLeft : rl.refusedLeft
    if (l.quantity > left)
      at(
        'quantity',
        'OVER_RETURN',
        `Linha ${rl.line_no}: só ${t6(left)} ${l.source === 'ACCEPTED' ? 'aceite' : 'recusado'} por devolver.`
      )
    const stocked = !!rl.stocked && l.source === 'ACCEPTED' && rl.base_quantity !== null
    const base = stocked ? baseOf(l.quantity, rl) : null
    if (!stocked) {
      if (l.serials.length) at('serials', 'NOT_STOCKED', 'Séries só no que saiu do stock.')
      if (l.locationId) at('locationId', 'NOT_STOCKED', 'Localização só no que sai do stock.')
      if (l.bucket !== 'UNRESTRICTED')
        at('bucket', 'NOT_STOCKED', 'O estado de stock só no que sai do stock.')
    } else {
      if (l.locationId && !locs.has(l.locationId))
        at('locationId', 'NOT_FOUND', 'Localização que não é do armazém da recepção.')
      if (rl.track_serials) {
        const received = new Set<string>((rl.serials as string[]) ?? [])
        if (base !== null && BigInt(l.serials.length) * 1_000_000n !== base)
          at('serials', 'SERIAL_COUNT', 'Indique uma série por unidade devolvida.')
        const foreign = l.serials.filter((s) => !received.has(s))
        if (foreign.length)
          at(
            'serials',
            'NOT_RECEIVED',
            `Séries que não vieram nesta recepção: ${foreign.join(', ')}.`
          )
      }
    }
    return { ...l, rl, stocked, base }
  })
  fail(issues)
  return out
}

async function writeLines(scope: TenantScope, id: string, lines: any[]) {
  const t = scope.context.tenantId
  const u = scope.context.userId
  await scope.trx.rawQuery(
    `delete from purchase_return_lines where tenant_id = ? and return_id = ?`,
    [t, id]
  )
  for (const [i, l] of lines.entries())
    await scope.trx.rawQuery(
      `insert into purchase_return_lines (tenant_id, return_id, receipt_line_id, order_line_id, line_no, source,
          product_id, variant_id, stocked, quantity, location_id, bucket, lot_code, serials, notes, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        id,
        l.receiptLineId,
        l.rl.order_line_id,
        i + 1,
        l.source,
        l.rl.product_id,
        l.rl.variant_id,
        l.stocked,
        t6(l.quantity),
        l.stocked ? (l.locationId ?? l.rl.location_id) : null,
        l.stocked ? l.bucket : null,
        l.stocked ? l.rl.lot_code : null,
        l.stocked && l.serials.length ? JSON.stringify(l.serials) : null,
        l.notes,
        u,
        u,
      ] as never[]
    )
}

async function evidenceCount(scope: TenantScope, id: string) {
  return Number(
    (
      (
        await scope.trx.rawQuery(
          `select count(*)::int as n from attachments where tenant_id = ? and subject_type = 'purchase_return'
              and subject_id = ? and status = 'ACTIVE'`,
          [scope.context.tenantId, id]
        )
      ).rows[0] as any
    ).n
  )
}

/** Recalcula os estados de recepção e de facturação da ordem pelas linhas. */
async function refreshOrder(scope: TenantScope, orderId: string) {
  const ls = (
    await scope.trx.rawQuery(
      `select quantity, received_quantity, invoiced_quantity, cancelled_quantity from purchase_order_lines
        where tenant_id = ? and order_id = ?`,
      [scope.context.tenantId, orderId]
    )
  ).rows as any[]
  const facts = ls.map((l) => ({
    quantity: q6(l.quantity),
    received: q6(l.received_quantity),
    invoiced: q6(l.invoiced_quantity),
    cancelled: q6(l.cancelled_quantity),
  }))
  const receipt = orderReceiptStatus(facts)
  const invoice = orderInvoiceStatus(facts)
  await scope.trx.rawQuery(
    `update purchase_orders set receipt_status = ?, invoice_status = ?, updated_at = now(), version = version + 1
      where tenant_id = ? and id = ? and (receipt_status <> ? or invoice_status <> ?)`,
    [receipt, invoice, scope.context.tenantId, orderId, receipt, invoice]
  )
  return { receipt, invoice }
}

async function detail(scope: TenantScope, id: string) {
  const { r, g } = await authorized(scope, id, 'read')
  const t = scope.context.tenantId
  const info = (
    await scope.trx.rawQuery(
      `select o.number as order_number, rc.number as receipt_number, le.code as le_code, bp.code as sup_code,
          bp.name as sup_name, w.code as wh_code, w.name as wh_name, uc.full_name as confirmed_name
         from purchase_returns r join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
         join purchase_receipts rc on rc.tenant_id = r.tenant_id and rc.id = r.receipt_id
         join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
         join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
         left join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
         left join users uc on uc.id = r.confirmed_by
        where r.tenant_id = ? and r.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  const lines = (
    await scope.trx.rawQuery(
      `select l.*, ol.description, ol.uom_code, ol.line_no as order_line_no, rl.line_no as receipt_line_no,
          p.sku, bu.code as base_uom_code, wl.path_code
         from purchase_return_lines l
         join purchase_order_lines ol on ol.tenant_id = l.tenant_id and ol.id = l.order_line_id
         join purchase_receipt_lines rl on rl.tenant_id = l.tenant_id and rl.id = l.receipt_line_id
         left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         left join uoms bu on bu.tenant_id = p.tenant_id and bu.id = p.base_uom_id
         left join warehouse_locations wl on wl.tenant_id = l.tenant_id and wl.id = l.location_id
        where l.tenant_id = ? and l.return_id = ? order by l.line_no`,
      [t, id]
    )
  ).rows as any[]
  const credits = (
    await scope.trx.rawQuery(
      `select c.id, c.number, c.credit_note_number, c.status, c.total_amount, c.currency, c.credit_note_date
         from purchase_credit_notes c where c.tenant_id = ? and c.return_id = ? order by c.created_at`,
      [t, id]
    )
  ).rows as any[]
  // Facturas validadas da ordem (para registar a nota de crédito a partir da devolução).
  const invoices = (
    await scope.trx.rawQuery(
      `select id, number, invoice_number from purchase_invoices where tenant_id = ? and order_id = ?
          and status = 'VALIDATED' order by validated_at`,
      [t, r.order_id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from purchase_return_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.return_id = ? order by e.created_at desc, e.id`,
      [t, id]
    )
  ).rows as any[]
  const credit = await permissionScope(scope, 'procurement.invoices.manage')
  const status = r.status as ReturnStatus
  const evidence = await evidenceCount(scope, id)
  return {
    id: r.id as string,
    version: Number(r.version),
    number: (r.number as string) ?? null,
    status,
    creditStatus: r.credit_status as CreditStatus,
    legalEntity: { id: r.legal_entity_id as string, code: info.le_code as string },
    receipt: { id: r.receipt_id as string, number: info.receipt_number as string },
    order: { id: r.order_id as string, number: info.order_number as string },
    supplier: {
      id: r.supplier_id as string,
      code: info.sup_code as string,
      name: info.sup_name as string,
    },
    warehouse: r.warehouse_id
      ? { id: r.warehouse_id as string, code: info.wh_code as string, name: info.wh_name as string }
      : null,
    returnDate: isoDate(r.return_date)!,
    reasonCode: r.reason_code as string,
    description: r.description as string,
    remedy: r.remedy as Remedy,
    carrierRef: (r.carrier_ref as string) ?? null,
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
    confirmedBy: (info.confirmed_name as string) ?? null,
    integrationEventId: (r.integration_event_id as string) ?? null,
    postingId: (r.posting_id as string) ?? null,
    cancelReason: (r.cancel_reason as string) ?? null,
    evidenceCount: evidence,
    lines: lines.map((l) => ({
      id: l.id as string,
      lineNo: Number(l.line_no),
      receiptLineId: l.receipt_line_id as string,
      receiptLineNo: Number(l.receipt_line_no),
      orderLineId: l.order_line_id as string,
      orderLineNo: Number(l.order_line_no),
      source: l.source as 'ACCEPTED' | 'REFUSED',
      product: l.product_id ? { id: l.product_id as string, sku: l.sku as string } : null,
      description: l.description as string,
      uom: (l.uom_code as string) ?? null,
      baseUom: (l.base_uom_code as string) ?? null,
      stocked: l.stocked as boolean,
      quantity: t6(q6(l.quantity)),
      baseQuantity: l.base_quantity === null ? null : t6(q6(l.base_quantity)),
      location: l.location_id ? { id: l.location_id as string, path: l.path_code as string } : null,
      bucket: (l.bucket as string) ?? null,
      lotCode: (l.lot_code as string) ?? null,
      serials: (l.serials as string[]) ?? [],
      creditQuantity: t6(q6(l.credit_quantity)),
      creditedQuantity: t6(q6(l.credited_quantity)),
      notes: (l.notes as string) ?? null,
    })),
    creditNotes: credits.map((c) => ({
      id: c.id as string,
      number: (c.number as string) ?? null,
      creditNoteNumber: c.credit_note_number as string,
      status: c.status as string,
      totalAmount: scaledText(parseScaled(String(c.total_amount), 2) ?? 0n, 2),
      currency: c.currency as string,
      creditNoteDate: isoDate(c.credit_note_date)!,
    })),
    invoices: invoices.map((x) => ({
      id: x.id as string,
      number: x.number as string,
      invoiceNumber: x.invoice_number as string,
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
      confirm: g.manage && status === 'DRAFT',
      confirmBlockedBy:
        g.manage && status === 'DRAFT' && evidence === 0 ? 'EVIDENCE_REQUIRED' : null,
      cancel: g.manage && status === 'DRAFT',
      credit:
        status === 'CONFIRMED' &&
        r.credit_status === 'PENDING' &&
        covers(credit, r.legal_entity_id) &&
        invoices.length > 0,
    },
  }
}

export type ReturnDetail = Awaited<ReturnType<typeof detail>>

export class ReturnService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      creditStatus?: string
      receiptId?: string
      orderId?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const les = anyLe(await scopesOf(scope))
      if (les !== 'ALL' && !les.length) return { items: [], total: 0 }
      const where = ['r.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (les !== 'ALL') {
        where.push('r.legal_entity_id = any(?::uuid[])')
        params.push(les)
      }
      if (f.status && (RETURN_STATUSES as readonly string[]).includes(f.status)) {
        where.push('r.status = ?')
        params.push(f.status)
      }
      if (f.creditStatus) {
        where.push('r.credit_status = ?')
        params.push(f.creditStatus)
      }
      for (const [k, col] of [
        ['receiptId', 'r.receipt_id'],
        ['orderId', 'r.order_id'],
      ] as const)
        if (f[k] && isUuid(f[k])) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(r.number, '')) like ? or lower(o.number) like ? or lower(bp.name) like ?
             or lower(r.description) like ?)`
        )
        params.push(like, like, like, like)
      }
      const from = `from purchase_returns r join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
        join purchase_receipts rc on rc.tenant_id = r.tenant_id and rc.id = r.receipt_id
        join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
        join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select r.*, o.number as order_number, rc.number as receipt_number, bp.code as sup_code, bp.name as sup_name
             ${from} order by r.created_at desc, r.id limit ? offset ?`,
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
        items: rows.map((r) => ({
          id: r.id as string,
          number: (r.number as string) ?? null,
          status: r.status as ReturnStatus,
          creditStatus: r.credit_status as CreditStatus,
          receipt: { id: r.receipt_id as string, number: r.receipt_number as string },
          order: { id: r.order_id as string, number: r.order_number as string },
          supplier: {
            id: r.supplier_id as string,
            code: r.sup_code as string,
            name: r.sup_name as string,
          },
          returnDate: isoDate(r.return_date)!,
          reasonCode: r.reason_code as string,
          remedy: r.remedy as Remedy,
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  /** O que uma recepção tem por devolver (para o formulário). */
  returnableReceipt(context: TenantContext, receiptId: string, exceptReturnId: string | null) {
    return runInTenant(context, async (scope) => {
      const rc = await loadReceipt(scope, receiptId)
      const g = rights(await scopesOf(scope), rc.legal_entity_id)
      if (!g.read) throw ApiError.notFound()
      const rls = await receiptLines(
        scope,
        rc.id,
        exceptReturnId && isUuid(exceptReturnId) ? exceptReturnId : null
      )
      const locs = rc.warehouse_id
        ? ((
            await scope.trx.rawQuery(
              `select id, path_code from warehouse_locations where tenant_id = ? and warehouse_id = ?
                and holds_stock and status = 'ACTIVE' order by path_code`,
              [context.tenantId, rc.warehouse_id]
            )
          ).rows as any[])
        : []
      return {
        id: rc.id as string,
        number: (rc.number as string) ?? null,
        returnable: rc.status === 'CONFIRMED',
        order: {
          id: rc.order_id as string,
          number: rc.order_number as string,
          closed: !!rc.order_closed_at || rc.order_approval === 'CANCELLED',
        },
        supplier: {
          id: rc.supplier_id as string,
          code: rc.sup_code as string,
          name: rc.sup_name as string,
        },
        warehouseId: (rc.warehouse_id as string) ?? null,
        receiptDate: isoDate(rc.receipt_date)!,
        locations: locs.map((x) => ({ id: x.id as string, path: x.path_code as string })),
        lines: rls.map((l) => ({
          id: l.id as string,
          lineNo: Number(l.line_no),
          orderLineNo: Number(l.order_line_no),
          product: l.product_id ? { id: l.product_id as string, sku: l.sku as string } : null,
          description: l.description as string,
          uom: (l.uom_code as string) ?? null,
          baseUom: (l.base_uom_code as string) ?? null,
          stocked: !!l.stocked && l.base_quantity !== null,
          accepted: t6(q6(l.quantity)),
          refused: t6(q6(l.rejected_quantity)),
          rejectReason: (l.reject_reason as string) ?? null,
          acceptedLeft: t6(l.acceptedLeft),
          refusedLeft: t6(l.refusedLeft),
          location: l.location_id
            ? { id: l.location_id as string, path: l.path_code as string }
            : null,
          lotCode: (l.lot_code as string) ?? null,
          serials: (l.serials as string[]) ?? [],
          tracking: { lots: !!l.track_lots, serials: !!l.track_serials },
        })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const rc = await loadReceipt(scope, input.receiptId as string)
      const g = rights(await scopesOf(scope), rc.legal_entity_id)
      if (!g.read) throw ApiError.notFound()
      if (!g.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista devoluções desta entidade.')
      if (rc.status !== 'CONFIRMED')
        throw ApiError.conflict(
          'NOT_RETURNABLE',
          'Só se devolve o que veio numa recepção confirmada (e não estornada).'
        )
      const { header, issues } = normalizeReturnHeader(input, today())
      fail(issues)
      const lines = await linesFor(scope, rc, input.lines, null)
      const ins = await scope.trx.rawQuery(
        `insert into purchase_returns (tenant_id, legal_entity_id, receipt_id, order_id, supplier_id, warehouse_id,
            return_date, reason_code, description, remedy, carrier_ref, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          rc.legal_entity_id,
          rc.id,
          rc.order_id,
          rc.supplier_id,
          rc.warehouse_id,
          header.returnDate,
          header.reasonCode,
          header.description,
          header.remedy,
          header.carrierRef,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await writeLines(scope, id, lines)
      await event(scope, id, 'CREATED')
      await audit(scope, {
        action: 'purchase_return.created',
        entityType: 'purchase_return',
        entityId: id,
        changes: {
          receiptId: { from: null, to: rc.id },
          remedy: { from: null, to: header.remedy },
        },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'DRAFT') throw ApiError.conflict('INVALID_STATE', 'Só se altera o rascunho.')
      const rc = await loadReceipt(scope, r.receipt_id)
      const { header, issues } = normalizeReturnHeader(input, today())
      fail(issues)
      const lines = await linesFor(scope, rc, input.lines, id)
      await writeLines(scope, id, lines)
      await setReturn(scope, id, {
        return_date: header.returnDate,
        reason_code: header.reasonCode,
        description: header.description,
        remedy: header.remedy,
        carrier_ref: header.carrierRef,
      })
      await event(scope, id, 'UPDATED')
      return detail(scope, id)
    })
  }

  /**
   * Confirmar: evidência obrigatória; com a ordem bloqueada (devoluções e recepções em simultâneo esperam), volta a
   * verificar o que se pode devolver, dá o número, faz uma única saída no Inventário (idempotente pela devolução) e
   * acerta recebido, cancelado e crédito pendente.
   */
  confirm(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'DRAFT')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Esta devolução já não está em rascunho (não se confirma duas vezes).'
        )
      if ((await evidenceCount(scope, id)) === 0)
        throw ApiError.conflict(
          'EVIDENCE_REQUIRED',
          'Junte pelo menos uma evidência (fotografia, relatório de inspecção, guia) antes de confirmar.'
        )
      const t = context.tenantId
      const o = (
        await scope.trx.rawQuery(
          `select o.*, bp.code as sup_code from purchase_orders o
             join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
             join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
            where o.tenant_id = ? and o.id = ? for update of o`,
          [t, r.order_id]
        )
      ).rows[0] as any
      const remedy = r.remedy as Remedy
      if (remedy === 'REPLACEMENT' && (o.closed_at || o.approval_status === 'CANCELLED'))
        throw ApiError.conflict(
          'ORDER_CLOSED',
          'A ordem está fechada: não espera substituição — devolva a crédito.'
        )
      const rc = await loadReceipt(scope, r.receipt_id)
      if (rc.status !== 'CONFIRMED')
        throw ApiError.conflict('NOT_RETURNABLE', 'A recepção deixou de estar confirmada.')
      const ols = new Map(
        (
          (
            await scope.trx.rawQuery(
              `select * from purchase_order_lines where tenant_id = ? and order_id = ? for update`,
              [t, o.id]
            )
          ).rows as any[]
        ).map((l) => [l.id as string, l])
      )
      const rls = new Map((await receiptLines(scope, rc.id, id)).map((l) => [l.id as string, l]))
      const lines = (
        await scope.trx.rawQuery(
          `select * from purchase_return_lines where tenant_id = ? and return_id = ? order by line_no`,
          [t, id]
        )
      ).rows as any[]
      const issues: ErrorDetail[] = []
      const stock: any[] = []
      for (const [i, l] of lines.entries()) {
        const rl = rls.get(l.receipt_line_id)!
        const qty = q6(l.quantity)
        const left = l.source === 'ACCEPTED' ? rl.acceptedLeft : rl.refusedLeft
        if (qty > left)
          issues.push({
            path: `lines.${i}.quantity`,
            code: 'OVER_RETURN',
            message: `Linha ${rl.line_no}: entretanto só ${t6(left)} por devolver.`,
          })
        if (!l.stocked) continue
        const base = baseOf(qty, rl)!
        await scope.trx.rawQuery(
          `update purchase_return_lines set base_quantity = ?, updated_at = now(), version = version + 1
            where tenant_id = ? and id = ?`,
          [t6(base), t, l.id] as never[]
        )
        stock.push({
          productId: l.product_id,
          variantId: l.variant_id,
          locationId: l.location_id,
          bucket: l.bucket,
          quantity: t6(base),
          lotCode: l.lot_code,
          serials: l.serials ?? null,
        })
      }
      fail(issues)
      // Ordem: o aceite devolvido deixa de contar como recebido; a crédito, deixa de ser esperado.
      const credit: { id: string; need: bigint }[] = []
      for (const l of lines) {
        const ol = ols.get(l.order_line_id)!
        const qty = q6(l.quantity)
        let received = q6(ol.received_quantity)
        let cancelled = q6(ol.cancelled_quantity)
        if (l.source === 'ACCEPTED') received -= qty
        const openAfter = q6(ol.quantity) - received - cancelled
        cancelled += cancelOnCredit({ remedy, quantity: qty, openAfter })
        const need = creditNeed({
          remedy,
          quantity: qty,
          invoiced: q6(ol.invoiced_quantity),
          receivedAfter: received,
        })
        ol.received_quantity = t6(received)
        ol.cancelled_quantity = t6(cancelled)
        credit.push({ id: l.id as string, need })
      }
      for (const c of credit)
        if (c.need > 0n)
          await scope.trx.rawQuery(
            `update purchase_return_lines set credit_quantity = ?, updated_at = now(), version = version + 1
              where tenant_id = ? and id = ?`,
            [t6(c.need), t, c.id] as never[]
          )
      const ser = await scope.trx.rawQuery(
        `select id from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ? and status = 'ACTIVE'
            and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
            and (branch_id is null or branch_id is not distinct from ?)
          order by (branch_id is not null) desc, code limit 1`,
        [t, r.legal_entity_id, RETURN_SERIES_TYPE, today(), today(), o.branch_id] as never[]
      )
      const series = ser.rows[0] as { id: string } | undefined
      if (!series)
        throw ApiError.conflict(
          'NO_SERIES',
          `Sem série documental ${RETURN_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
        )
      const number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      // Uma única saída no Inventário para o que estava em stock (idempotente pela devolução).
      let integration: { id: string; postingId: string | null } | null = null
      if (stock.length)
        integration = await returnToSupplier(scope, {
          idempotencyKey: `prt-${id}`,
          warehouseId: r.warehouse_id,
          orderRef: o.number,
          documentRef: number,
          counterpartyRef: o.sup_code,
          returnOfDocumentRef: rc.number,
          lines: stock,
        })
      for (const ol of ols.values())
        await scope.trx.rawQuery(
          `update purchase_order_lines set received_quantity = ?, cancelled_quantity = ?, updated_at = now(),
              version = version + 1 where tenant_id = ? and id = ?
              and (received_quantity <> ?::numeric or cancelled_quantity <> ?::numeric)`,
          [
            ol.received_quantity,
            ol.cancelled_quantity,
            t,
            ol.id,
            ol.received_quantity,
            ol.cancelled_quantity,
          ] as never[]
        )
      const orderStatus = await refreshOrder(scope, o.id)
      const creditStatus = creditStatusOf(
        credit.map((c) => ({ creditQuantity: c.need, credited: 0n }))
      )
      await setReturn(scope, id, {
        status: 'CONFIRMED',
        credit_status: creditStatus,
        series_id: series.id,
        number,
        confirmed_at: new Date(),
        confirmed_by: context.userId,
        integration_event_id: integration?.id ?? null,
        posting_id: integration?.postingId ?? null,
      })
      await event(scope, id, 'CONFIRMED', {
        details: {
          number,
          postingId: integration?.postingId ?? null,
          creditStatus,
          orderReceiptStatus: orderStatus.receipt,
          orderInvoiceStatus: orderStatus.invoice,
        },
      })
      await audit(scope, {
        action: 'purchase_return.confirmed',
        entityType: 'purchase_return',
        entityId: id,
        changes: {
          status: { from: 'DRAFT', to: 'CONFIRMED' },
          number: { from: null, to: number },
          creditStatus: { from: 'NOT_REQUIRED', to: creditStatus },
        },
      })
      return detail(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'DRAFT')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se anula o rascunho (confirmada, a mercadoria já saiu).'
        )
      const reason = reasonOf(input.reason)
      await setReturn(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await event(scope, id, 'CANCELLED', { reason })
      await audit(scope, {
        action: 'purchase_return.cancelled',
        entityType: 'purchase_return',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'CANCELLED' } },
      })
      return detail(scope, id)
    })
  }
}

/** A recepção tem devoluções (não anuladas)? — a recepção já não se estorna. */
export async function receiptHasReturns(scope: TenantScope, receiptId: string) {
  return (
    (
      await scope.trx.rawQuery(
        `select 1 from purchase_returns where tenant_id = ? and receipt_id = ? and status <> 'CANCELLED' limit 1`,
        [scope.context.tenantId, receiptId]
      )
    ).rows.length > 0
  )
}

/** Existe nesta empresa e o membro pode ler (anexos): `null` sem acesso. */
export async function purchaseReturnAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const r = (
    await scope.trx.rawQuery(
      `select legal_entity_id, status from purchase_returns where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) return null
  const g = rights(await scopesOf(scope), r.legal_entity_id)
  // Evidências: juntam-se em rascunho; confirmada, ficam (a não conformidade não se reescreve).
  return g.read ? { read: true, write: g.manage && r.status === 'DRAFT' } : null
}
