import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import { receivePurchase, reverseStockPosting } from '#modules/inventory/index'
import { isDate, parseScaled, scaledText } from '#modules/procurement/domain/requisitions'
import { receiptStatus as orderReceiptStatus } from '#modules/procurement/domain/orders'
import {
  deliveryState,
  normalizeReceiptLines,
  openQuantity,
  RECEIPT_SERIES_TYPE,
  RECEIPT_STATUSES,
  type ReceiptStatus,
  toBaseQuantity,
  unitCostFunctional,
} from '#modules/procurement/domain/receipts'
import { receiptHasReturns } from '#modules/procurement/application/return_service'

/*
 * Recepções de compra (9.7). Permissões no âmbito da entidade legal: `procurement.receipts.read` e `.manage` (registar,
 * confirmar, anular o rascunho, estornar). A confirmação, com a ordem bloqueada, verifica o que falta receber, dá o
 * número e faz **uma** entrada no Inventário para os bens armazenáveis (`receivePurchase`, idempotente pela recepção:
 * repetir não duplica o movimento); serviços e artigos não armazenáveis são só aceites. O estorno estorna o lançamento
 * (`reverseStockPosting`, idempotente) e devolve as quantidades à ordem — nunca abaixo do já facturado.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const c2 = (v: unknown) => parseScaled(String(v ?? '0'), 2) ?? 0n
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
}
async function scopesOf(scope: TenantScope): Promise<Scopes> {
  return {
    read: await permissionScope(scope, 'procurement.receipts.read'),
    manage: await permissionScope(scope, 'procurement.receipts.manage'),
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
      `select * from purchase_receipts where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
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
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista recepções desta entidade.')
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
    `insert into purchase_receipt_events (tenant_id, receipt_id, kind, reason, details, created_by, updated_by)
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

async function setReceipt(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update purchase_receipts set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/** A ordem aceita recepções? Aprovada, emitida na revisão em vigor, não fechada nem anulada. */
function receivable(o: any) {
  return (
    o.approval_status === 'APPROVED' &&
    o.issued_revision !== null &&
    Number(o.issued_revision) === Number(o.revision) &&
    !o.closed_at
  )
}

/** Linhas da ordem com o que falta receber e o que o Inventário precisa (tipo, rastreio, unidade base, factor). */
async function orderLines(scope: TenantScope, orderId: string, lock = false) {
  return (
    await scope.trx.rawQuery(
      `select l.*, p.sku, p.product_type, p.track_lots, p.track_expiry, p.track_serials, p.base_uom_id,
          bu.code as base_uom_code,
          case when l.uom_id is null or l.uom_id = p.base_uom_id then 1::numeric else c.factor end as factor
         from purchase_order_lines l
         left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         left join uoms bu on bu.tenant_id = p.tenant_id and bu.id = p.base_uom_id
         left join product_uom_conversions c on c.tenant_id = l.tenant_id and c.product_id = l.product_id
          and c.uom_id = l.uom_id
        where l.tenant_id = ? and l.order_id = ? order by l.line_no${lock ? ' for update of l' : ''}`,
      [scope.context.tenantId, orderId]
    )
  ).rows as any[]
}

const stockedLine = (l: any, warehouseId: string | null) =>
  !!l.product_id && l.product_type === 'STOCKABLE' && !!warehouseId

async function loadOrder(scope: TenantScope, orderId: string, lock = false) {
  if (!isUuid(orderId)) fail([{ path: 'orderId', code: 'REQUIRED', message: 'Ordem de compra.' }])
  const o = (
    await scope.trx.rawQuery(
      `select o.*, bp.code as sup_code, bp.name as sup_name from purchase_orders o
         join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        where o.tenant_id = ? and o.id = ?${lock ? ' for update of o' : ''}`,
      [scope.context.tenantId, orderId]
    )
  ).rows[0] as any
  // Inexistente (ou de outra empresa): 404, como os restantes registos.
  if (!o) throw ApiError.notFound()
  return o
}

/** Valida as linhas de uma recepção contra a ordem (pertença, em falta, recusa, localização do armazém). */
async function linesFor(scope: TenantScope, o: any, raw: unknown) {
  const { lines, issues } = normalizeReceiptLines(raw)
  const ols = await orderLines(scope, o.id)
  const byId = new Map(ols.map((l) => [l.id as string, l]))
  const locs = o.warehouse_id
    ? new Set(
        (
          (
            await scope.trx.rawQuery(
              `select id from warehouse_locations where tenant_id = ? and warehouse_id = ?`,
              [scope.context.tenantId, o.warehouse_id]
            )
          ).rows as any[]
        ).map((x) => x.id as string)
      )
    : new Set<string>()
  const out = lines.map((l, i) => {
    const at = (f: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${f}`, code, message })
    const ol = byId.get(l.orderLineId)
    if (!ol) {
      if (l.orderLineId) at('orderLineId', 'NOT_FOUND', 'Linha que não é desta ordem.')
      return { ...l, ol: null, stocked: false }
    }
    const open = openQuantity({
      quantity: q6(ol.quantity),
      received: q6(ol.received_quantity),
      cancelled: q6(ol.cancelled_quantity),
    })
    if (l.quantity > open)
      at(
        'quantity',
        'OVER_RECEIPT',
        `Só faltam receber ${scaledText(open, 6)} ${ol.uom_code ?? ''}.`.trim()
      )
    const stocked = stockedLine(ol, o.warehouse_id)
    if (!stocked && (l.lotCode || l.expiryDate || l.serials.length))
      at('lotCode', 'NOT_STOCKED', 'Lote, validade e séries só em bens armazenáveis.')
    if (l.locationId && (!stocked || !locs.has(l.locationId)))
      at('locationId', 'NOT_FOUND', 'Localização que não é do armazém da ordem.')
    if (stocked && ol.factor === null)
      at('quantity', 'NO_CONVERSION', `${ol.sku} não tem conversão para ${ol.uom_code}.`)
    return { ...l, ol, stocked }
  })
  fail(issues)
  return out
}

async function writeLines(scope: TenantScope, id: string, lines: any[]) {
  const t = scope.context.tenantId
  const u = scope.context.userId
  await scope.trx.rawQuery(
    `delete from purchase_receipt_lines where tenant_id = ? and receipt_id = ?`,
    [t, id]
  )
  for (const l of lines)
    await scope.trx.rawQuery(
      `insert into purchase_receipt_lines (tenant_id, receipt_id, order_line_id, line_no, product_id, variant_id,
          stocked, quantity, rejected_quantity, reject_reason, location_id, lot_code, expiry_date, serials, notes,
          created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        id,
        l.orderLineId,
        l.ol.line_no,
        l.ol.product_id,
        l.ol.variant_id,
        l.stocked,
        scaledText(l.quantity, 6),
        scaledText(l.rejectedQuantity, 6),
        l.rejectReason,
        l.locationId,
        l.lotCode,
        l.expiryDate,
        l.serials.length ? JSON.stringify(l.serials) : null,
        l.notes,
        u,
        u,
      ] as never[]
    )
}

/** Recalcula o estado de recepção da ordem pelas linhas. */
async function refreshOrder(scope: TenantScope, orderId: string) {
  const ls = await orderLines(scope, orderId)
  const status = orderReceiptStatus(
    ls.map((l) => ({
      quantity: q6(l.quantity),
      received: q6(l.received_quantity),
      cancelled: q6(l.cancelled_quantity),
    }))
  )
  await scope.trx.rawQuery(
    `update purchase_orders set receipt_status = ?, updated_at = now(), version = version + 1
      where tenant_id = ? and id = ? and receipt_status <> ?`,
    [status, scope.context.tenantId, orderId, status]
  )
  return status
}

async function detail(scope: TenantScope, id: string) {
  const { r, g } = await authorized(scope, id, 'read')
  const t = scope.context.tenantId
  const info = (
    await scope.trx.rawQuery(
      `select o.number as order_number, o.revision, o.closed_at, o.approval_status, o.issued_revision, le.code as le_code,
          bp.code as sup_code, bp.name as sup_name, w.code as wh_code, w.name as wh_name, uc.full_name as confirmed_name,
          ur.full_name as reversed_name
         from purchase_receipts r join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
         join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
         join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
         left join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
         left join users uc on uc.id = r.confirmed_by left join users ur on ur.id = r.reversed_by
        where r.tenant_id = ? and r.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  const lines = (
    await scope.trx.rawQuery(
      `select rl.*, ol.description, ol.uom_code, ol.quantity as ordered, ol.received_quantity, ol.cancelled_quantity,
          ol.invoiced_quantity, p.sku, p.track_lots, p.track_expiry, p.track_serials, bu.code as base_uom_code,
          wl.path_code
         from purchase_receipt_lines rl join purchase_order_lines ol on ol.tenant_id = rl.tenant_id and ol.id = rl.order_line_id
         left join products p on p.tenant_id = rl.tenant_id and p.id = rl.product_id
         left join uoms bu on bu.tenant_id = p.tenant_id and bu.id = p.base_uom_id
         left join warehouse_locations wl on wl.tenant_id = rl.tenant_id and wl.id = rl.location_id
        where rl.tenant_id = ? and rl.receipt_id = ? order by rl.line_no`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from purchase_receipt_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.receipt_id = ? order by e.created_at desc, e.id`,
      [t, id]
    )
  ).rows as any[]
  const status = r.status as ReceiptStatus
  const returns = { manage: await permissionScope(scope, 'procurement.returns.manage') }
  const returnList = (
    await scope.trx.rawQuery(
      `select id, number, status, credit_status, remedy, return_date from purchase_returns
        where tenant_id = ? and receipt_id = ? order by created_at`,
      [t, id]
    )
  ).rows as any[]
  const canReverse =
    status === 'CONFIRMED' &&
    !info.closed_at &&
    !(await receiptHasReturns(scope, id)) &&
    lines.every((l) => q6(l.received_quantity) - q6(l.quantity) >= q6(l.invoiced_quantity))
  return {
    id: r.id as string,
    version: Number(r.version),
    number: (r.number as string) ?? null,
    status,
    legalEntity: { id: r.legal_entity_id as string, code: info.le_code as string },
    order: { id: r.order_id as string, number: info.order_number as string },
    supplier: {
      id: r.supplier_id as string,
      code: info.sup_code as string,
      name: info.sup_name as string,
    },
    warehouse: r.warehouse_id
      ? { id: r.warehouse_id as string, code: info.wh_code as string, name: info.wh_name as string }
      : null,
    receiptDate: isoDate(r.receipt_date)!,
    deliveryNote: (r.delivery_note as string) ?? null,
    notes: (r.notes as string) ?? null,
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
    confirmedBy: (info.confirmed_name as string) ?? null,
    integrationEventId: (r.integration_event_id as string) ?? null,
    postingId: (r.posting_id as string) ?? null,
    reversalPostingId: (r.reversal_posting_id as string) ?? null,
    reversedAt: r.reversed_at ? new Date(r.reversed_at).toISOString() : null,
    reversedBy: (info.reversed_name as string) ?? null,
    reversalReason: (r.reversal_reason as string) ?? null,
    cancelReason: (r.cancel_reason as string) ?? null,
    returns: returnList.map((x) => ({
      id: x.id as string,
      number: (x.number as string) ?? null,
      status: x.status as string,
      creditStatus: x.credit_status as string,
      remedy: x.remedy as string,
      returnDate: isoDate(x.return_date)!,
    })),
    lines: lines.map((l) => ({
      id: l.id as string,
      orderLineId: l.order_line_id as string,
      lineNo: Number(l.line_no),
      product: l.product_id ? { id: l.product_id as string, sku: l.sku as string } : null,
      description: l.description as string,
      uom: (l.uom_code as string) ?? null,
      baseUom: (l.base_uom_code as string) ?? null,
      stocked: l.stocked as boolean,
      ordered: scaledText(q6(l.ordered), 6),
      quantity: scaledText(q6(l.quantity), 6),
      baseQuantity: l.base_quantity === null ? null : scaledText(q6(l.base_quantity), 6),
      rejectedQuantity: scaledText(q6(l.rejected_quantity), 6),
      rejectReason: (l.reject_reason as string) ?? null,
      location: l.location_id ? { id: l.location_id as string, path: l.path_code as string } : null,
      lotCode: (l.lot_code as string) ?? null,
      expiryDate: isoDate(l.expiry_date),
      serials: (l.serials as string[]) ?? [],
      unitCost: l.unit_cost === null ? null : scaledText(q6(l.unit_cost), 6),
      notes: (l.notes as string) ?? null,
      tracking: { lots: !!l.track_lots, expiry: !!l.track_expiry, serials: !!l.track_serials },
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
      cancel: g.manage && status === 'DRAFT',
      reverse: g.manage && canReverse,
      return: status === 'CONFIRMED' && covers(returns.manage, r.legal_entity_id),
    },
  }
}

export type ReceiptDetail = Awaited<ReturnType<typeof detail>>

export class ReceiptService {
  list(
    context: TenantContext,
    f: { q?: string; status?: string; orderId?: string; limit: number; offset: number }
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
      if (f.status && (RECEIPT_STATUSES as readonly string[]).includes(f.status)) {
        where.push('r.status = ?')
        params.push(f.status)
      }
      if (f.orderId && isUuid(f.orderId)) {
        where.push('r.order_id = ?')
        params.push(f.orderId)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(r.number, '')) like ? or lower(coalesce(o.number, '')) like ? or lower(bp.name) like ?
             or lower(coalesce(r.delivery_note, '')) like ?)`
        )
        params.push(like, like, like, like)
      }
      const from = `from purchase_receipts r join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
        join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
        join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        left join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select r.*, o.number as order_number, bp.code as sup_code, bp.name as sup_name, w.code as wh_code ${from}
            order by r.created_at desc, r.id limit ? offset ?`,
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
          status: r.status as ReceiptStatus,
          order: { id: r.order_id as string, number: r.order_number as string },
          supplier: {
            id: r.supplier_id as string,
            code: r.sup_code as string,
            name: r.sup_name as string,
          },
          warehouse: r.warehouse_id
            ? { id: r.warehouse_id as string, code: r.wh_code as string }
            : null,
          receiptDate: isoDate(r.receipt_date)!,
          deliveryNote: (r.delivery_note as string) ?? null,
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  /** Entregas previstas: linhas de ordens emitidas com quantidade em falta, pela data prevista (linha ou ordem). */
  expected(context: TenantContext, f: { state?: string; limit: number }) {
    return runInTenant(context, async (scope) => {
      const les = anyLe(await scopesOf(scope))
      if (les !== 'ALL' && !les.length) return []
      const rows = (
        await scope.trx.rawQuery(
          `select o.id as order_id, o.number, o.legal_entity_id, o.warehouse_id, coalesce(l.expected_date, o.expected_date) as expected,
              l.id, l.line_no, l.description, l.uom_code, l.quantity, l.received_quantity, l.cancelled_quantity,
              bp.code as sup_code, bp.name as sup_name
             from purchase_order_lines l join purchase_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
             join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
             join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
            where l.tenant_id = ? and o.approval_status = 'APPROVED' and o.issued_revision = o.revision
              and o.closed_at is null and l.quantity > l.received_quantity + l.cancelled_quantity
              ${les === 'ALL' ? '' : 'and o.legal_entity_id = any(?::uuid[])'}
            order by coalesce(l.expected_date, o.expected_date) nulls last, o.number, l.line_no limit ?`,
          (les === 'ALL'
            ? [context.tenantId, f.limit]
            : [context.tenantId, les, f.limit]) as never[]
        )
      ).rows as any[]
      const now = today()
      return rows
        .map((x) => {
          const open = openQuantity({
            quantity: q6(x.quantity),
            received: q6(x.received_quantity),
            cancelled: q6(x.cancelled_quantity),
          })
          const expected = isoDate(x.expected)
          return {
            order: { id: x.order_id as string, number: x.number as string },
            supplier: { code: x.sup_code as string, name: x.sup_name as string },
            lineId: x.id as string,
            lineNo: Number(x.line_no),
            description: x.description as string,
            uom: (x.uom_code as string) ?? null,
            ordered: scaledText(q6(x.quantity), 6),
            open: scaledText(open, 6),
            expectedDate: expected,
            state: deliveryState(expected, open, now),
          }
        })
        .filter((x) => !f.state || x.state === f.state)
    })
  }

  /** O que uma ordem tem por receber (para o formulário): linhas, rastreio do produto e localizações do armazém. */
  receivableOrder(context: TenantContext, orderId: string) {
    return runInTenant(context, async (scope) => {
      const o = await loadOrder(scope, orderId)
      const g = rights(await scopesOf(scope), o.legal_entity_id)
      if (!g.read) throw ApiError.notFound()
      const ls = await orderLines(scope, o.id)
      const locs = o.warehouse_id
        ? ((
            await scope.trx.rawQuery(
              `select id, path_code from warehouse_locations where tenant_id = ? and warehouse_id = ?
                and holds_stock and status = 'ACTIVE' order by path_code`,
              [context.tenantId, o.warehouse_id]
            )
          ).rows as any[])
        : []
      return {
        id: o.id as string,
        number: o.number as string,
        receivable: receivable(o),
        supplier: {
          id: o.supplier_id as string,
          code: o.sup_code as string,
          name: o.sup_name as string,
        },
        warehouseId: (o.warehouse_id as string) ?? null,
        expectedDate: isoDate(o.expected_date),
        locations: locs.map((x) => ({ id: x.id as string, path: x.path_code as string })),
        lines: ls.map((l) => ({
          id: l.id as string,
          lineNo: Number(l.line_no),
          product: l.product_id ? { id: l.product_id as string, sku: l.sku as string } : null,
          description: l.description as string,
          uom: (l.uom_code as string) ?? null,
          stocked: stockedLine(l, o.warehouse_id),
          ordered: scaledText(q6(l.quantity), 6),
          received: scaledText(q6(l.received_quantity), 6),
          open: scaledText(
            openQuantity({
              quantity: q6(l.quantity),
              received: q6(l.received_quantity),
              cancelled: q6(l.cancelled_quantity),
            }),
            6
          ),
          expectedDate: isoDate(l.expected_date),
          tracking: { lots: !!l.track_lots, expiry: !!l.track_expiry, serials: !!l.track_serials },
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
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não regista recepções desta entidade.')
      if (!receivable(o))
        throw ApiError.conflict(
          'NOT_RECEIVABLE',
          'Só se recebe uma ordem aprovada e emitida na revisão em vigor, não fechada.'
        )
      const h = header(input)
      const lines = await linesFor(scope, o, input.lines)
      const ins = await scope.trx.rawQuery(
        `insert into purchase_receipts (tenant_id, legal_entity_id, order_id, supplier_id, warehouse_id, receipt_date,
            delivery_note, notes, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          o.legal_entity_id,
          o.id,
          o.supplier_id,
          o.warehouse_id,
          h.receiptDate,
          h.deliveryNote,
          h.notes,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await writeLines(scope, id, lines)
      await event(scope, id, 'CREATED')
      await audit(scope, {
        action: 'purchase_receipt.created',
        entityType: 'purchase_receipt',
        entityId: id,
        changes: { orderId: { from: null, to: o.id } },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'DRAFT') throw ApiError.conflict('INVALID_STATE', 'Só se altera o rascunho.')
      const o = await loadOrder(scope, r.order_id)
      const h = header(input)
      const lines = await linesFor(scope, o, input.lines)
      await writeLines(scope, id, lines)
      await setReceipt(scope, id, {
        receipt_date: h.receiptDate,
        delivery_note: h.deliveryNote,
        notes: h.notes,
      })
      await event(scope, id, 'UPDATED')
      return detail(scope, id)
    })
  }

  /**
   * Confirmar: com a ordem bloqueada (recepções em simultâneo esperam), volta a verificar o que falta receber, calcula
   * a unidade base e o custo, dá o número e faz uma única entrada no Inventário (idempotente pela recepção).
   */
  confirm(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'DRAFT')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Esta recepção já não está em rascunho (não se confirma duas vezes).'
        )
      const t = context.tenantId
      const o = await loadOrder(scope, r.order_id, true)
      if (!receivable(o))
        throw ApiError.conflict(
          'NOT_RECEIVABLE',
          'A ordem deixou de aceitar recepções (fechada, anulada ou em revisão).'
        )
      const ols = new Map((await orderLines(scope, o.id, true)).map((l) => [l.id as string, l]))
      const rls = (
        await scope.trx.rawQuery(
          `select * from purchase_receipt_lines where tenant_id = ? and receipt_id = ? order by line_no`,
          [t, id]
        )
      ).rows as any[]
      const issues: ErrorDetail[] = []
      const rate = r10(o.exchange_rate ?? '1')
      const stock: any[] = []
      for (const [i, rl] of rls.entries()) {
        const ol = ols.get(rl.order_line_id)!
        const qty = q6(rl.quantity)
        const open = openQuantity({
          quantity: q6(ol.quantity),
          received: q6(ol.received_quantity),
          cancelled: q6(ol.cancelled_quantity),
        })
        if (qty > open)
          issues.push({
            path: `lines.${i}.quantity`,
            code: 'OVER_RECEIPT',
            message: `Linha ${ol.line_no}: entretanto só faltam receber ${scaledText(open, 6)}.`,
          })
        if (!rl.stocked || qty === 0n) continue
        if (ol.factor === null) {
          issues.push({
            path: `lines.${i}.quantity`,
            code: 'NO_CONVERSION',
            message: `${ol.sku} sem conversão de unidade.`,
          })
          continue
        }
        const factor = q6(ol.factor)
        const base = toBaseQuantity(qty, factor)
        const cost = unitCostFunctional(c2(ol.net_amount), q6(ol.quantity), rate, factor)
        await scope.trx.rawQuery(
          `update purchase_receipt_lines set base_quantity = ?, unit_cost = ?, updated_at = now(), version = version + 1
            where tenant_id = ? and id = ?`,
          [scaledText(base, 6), scaledText(cost, 6), t, rl.id] as never[]
        )
        stock.push({
          productId: rl.product_id,
          variantId: rl.variant_id,
          locationId: rl.location_id,
          quantity: scaledText(base, 6),
          unitCost: scaledText(cost, 6),
          lotCode: rl.lot_code,
          expiryDate: isoDate(rl.expiry_date),
          serials: rl.serials ?? null,
        })
      }
      if (!rls.some((rl) => q6(rl.quantity) > 0n || q6(rl.rejected_quantity) > 0n))
        issues.push({ path: 'lines', code: 'REQUIRED', message: 'A recepção não tem quantidades.' })
      fail(issues)
      const ser = await scope.trx.rawQuery(
        `select id from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ? and status = 'ACTIVE'
            and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
            and (branch_id is null or branch_id is not distinct from ?)
          order by (branch_id is not null) desc, code limit 1`,
        [t, r.legal_entity_id, RECEIPT_SERIES_TYPE, today(), today(), o.branch_id] as never[]
      )
      const series = ser.rows[0] as { id: string } | undefined
      if (!series)
        throw ApiError.conflict(
          'NO_SERIES',
          `Sem série documental ${RECEIPT_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
        )
      const number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      // Uma única entrada no Inventário para todos os bens armazenáveis (idempotente pela recepção).
      let integration: { id: string; postingId: string | null } | null = null
      if (stock.length)
        integration = await receivePurchase(scope, {
          idempotencyKey: `pr-${id}`,
          warehouseId: r.warehouse_id,
          orderRef: o.number,
          documentRef: number,
          counterpartyRef: o.sup_code,
          lines: stock,
        })
      for (const rl of rls) {
        const qty = q6(rl.quantity)
        if (qty === 0n) continue
        const ol = ols.get(rl.order_line_id)!
        await scope.trx.rawQuery(
          `update purchase_order_lines set received_quantity = ?, updated_at = now(), version = version + 1
            where tenant_id = ? and id = ?`,
          [scaledText(q6(ol.received_quantity) + qty, 6), t, ol.id] as never[]
        )
      }
      const orderStatus = await refreshOrder(scope, o.id)
      await setReceipt(scope, id, {
        status: 'CONFIRMED',
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
          orderReceiptStatus: orderStatus,
        },
      })
      await audit(scope, {
        action: 'purchase_receipt.confirmed',
        entityType: 'purchase_receipt',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'CONFIRMED' }, number: { from: null, to: number } },
      })
      return detail(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'DRAFT')
        throw ApiError.conflict('INVALID_STATE', 'Só se anula o rascunho (confirmada, estorne).')
      const reason = reasonOf(input.reason)
      await setReceipt(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await event(scope, id, 'CANCELLED', { reason })
      await audit(scope, {
        action: 'purchase_receipt.cancelled',
        entityType: 'purchase_receipt',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'CANCELLED' } },
      })
      return detail(scope, id)
    })
  }

  /** Estornar uma recepção confirmada: estorno do lançamento de stock e devolução das quantidades à ordem. */
  reverse(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'CONFIRMED')
        throw ApiError.conflict('INVALID_STATE', 'Só se estorna uma recepção confirmada.')
      const reason = reasonOf(input.reason)
      const t = context.tenantId
      const o = await loadOrder(scope, r.order_id, true)
      if (await receiptHasReturns(scope, id))
        throw ApiError.conflict(
          'RECEIPT_RETURNED',
          'A recepção tem devoluções: já não se estorna (corrija com nova recepção ou devolução).'
        )
      if (o.closed_at)
        throw ApiError.conflict(
          'ORDER_CLOSED',
          'A ordem já foi fechada: a recepção não se estorna.'
        )
      const ols = new Map((await orderLines(scope, o.id, true)).map((l) => [l.id as string, l]))
      const rls = (
        await scope.trx.rawQuery(
          `select * from purchase_receipt_lines where tenant_id = ? and receipt_id = ?`,
          [t, id]
        )
      ).rows as any[]
      for (const rl of rls) {
        const ol = ols.get(rl.order_line_id)!
        if (q6(ol.received_quantity) - q6(rl.quantity) < q6(ol.invoiced_quantity))
          throw ApiError.conflict(
            'RECEIPT_INVOICED',
            `A linha ${ol.line_no} já foi facturada: corrija com uma devolução (9.9), não com o estorno.`
          )
      }
      let reversalId: string | null = null
      if (r.posting_id) {
        const rev = await reverseStockPosting(scope, r.posting_id, {
          idempotencyKey: `pr-rev-${id}`,
          reason: `Estorno da recepção ${r.number}: ${reason}`.slice(0, 200),
          checkAccess: false,
        })
        reversalId = (rev as any).posting?.id ?? null
      }
      for (const rl of rls) {
        const qty = q6(rl.quantity)
        if (qty === 0n) continue
        const ol = ols.get(rl.order_line_id)!
        await scope.trx.rawQuery(
          `update purchase_order_lines set received_quantity = ?, updated_at = now(), version = version + 1
            where tenant_id = ? and id = ?`,
          [scaledText(q6(ol.received_quantity) - qty, 6), t, ol.id] as never[]
        )
      }
      const orderStatus = await refreshOrder(scope, o.id)
      await setReceipt(scope, id, {
        status: 'REVERSED',
        reversal_posting_id: reversalId,
        reversed_at: new Date(),
        reversed_by: context.userId,
        reversal_reason: reason,
      })
      await event(scope, id, 'REVERSED', {
        reason,
        details: { reversalPostingId: reversalId, orderReceiptStatus: orderStatus },
      })
      await audit(scope, {
        action: 'purchase_receipt.reversed',
        entityType: 'purchase_receipt',
        entityId: id,
        changes: { status: { from: 'CONFIRMED', to: 'REVERSED' } },
      })
      return detail(scope, id)
    })
  }
}

function header(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const receiptDate =
    input.receiptDate === undefined || input.receiptDate === '' ? today() : input.receiptDate
  if (!isDate(receiptDate))
    issues.push({ path: 'receiptDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  else if (receiptDate > today())
    issues.push({
      path: 'receiptDate',
      code: 'FUTURE',
      message: 'A recepção não pode ter data futura.',
    })
  const deliveryNote = text(input.deliveryNote) || null
  if (deliveryNote && deliveryNote.length > 60)
    issues.push({ path: 'deliveryNote', code: 'LENGTH', message: 'Até 60 caracteres.' })
  const notes = text(input.notes) || null
  if (notes && notes.length > 2000)
    issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 2000 caracteres.' })
  fail(issues)
  return { receiptDate: receiptDate as string, deliveryNote, notes }
}

/** Existe nesta empresa e o membro pode ler (anexos): `null` sem acesso. */
export async function purchaseReceiptAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const r = (
    await scope.trx.rawQuery(
      `select legal_entity_id from purchase_receipts where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) return null
  const g = rights(await scopesOf(scope), r.legal_entity_id)
  return g.read ? { read: true, write: g.manage } : null
}
