import { createHash } from 'node:crypto'
import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts } from '#modules/organization/index'
import { documentSeriesFacts, rateOn, reserveDocumentNumber } from '#modules/settings/index'
import { deliverSale, releaseSaleReservation, reserveForSale } from '#modules/inventory/index'
import { customerSnapshot } from '#modules/sales/application/customer_service'
import { searchSalesRefs } from '#modules/sales/application/pricing_service'
import {
  acceptedQuote,
  customerActive,
  customerRow,
  markQuoteConverted,
  priced,
  salespersonOk,
} from '#modules/sales/application/quote_service'
import {
  dbScaled,
  divRound,
  PCT_SCALE,
  PRICE_SCALE,
  QTY_SCALE,
  scaledText,
} from '#modules/sales/domain/pricing'
import { type LineInput, normalizeLines } from '#modules/sales/domain/quotes'
import {
  creditCheck,
  deliveryStatus,
  invoicingStatus,
  normalizeDelivery,
  normalizeOrderHeader,
  normalizeQtyRequest,
  openQty,
  ORDER_STATUSES,
  qtyText,
  type QtyLine,
  reservationStatus,
  SERIES_TYPE,
} from '#modules/sales/domain/orders'

/*
 * Encomendas de venda (10.4). Permissões no âmbito da entidade legal (ou próprias, OWN): `sales.orders.read`,
 * `.manage` (criar, converter orçamentos, editar, submeter, fechar, anular), `.approve` (aprovar excepções de preço e
 * de crédito de outra pessoa) e `.fulfil` (reservar, libertar e expedir). O stock é do Inventário: reserva, libertação
 * e expedição pelos seus contratos idempotentes (`reserveForSale`, `releaseSaleReservation`, `deliverSale`), com a
 * encomenda como referência; os serviços são prestados sem passar pelo inventário.
 */

const today = () => new Date().toISOString().slice(0, 10)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const money = (v: unknown) => scaledText(dbScaled(v, 2), 2)
const qty = (v: unknown) => dbScaled(v, QTY_SCALE)
const num = (v: unknown, scale: number) =>
  v === null || v === undefined ? null : scaledText(dbScaled(v, scale), scale)

type Need = 'read' | 'manage' | 'approve' | 'fulfil'
type Scopes = Record<Need, PermissionScope>
async function scopesOf(scope: TenantScope): Promise<Scopes> {
  return {
    read: await permissionScope(scope, 'sales.orders.read'),
    manage: await permissionScope(scope, 'sales.orders.manage'),
    approve: await permissionScope(scope, 'sales.orders.approve'),
    fulfil: await permissionScope(scope, 'sales.orders.fulfil'),
  }
}
const covers = (s: PermissionScope, le: string, salesperson: string | null, me: string) =>
  s.tenant || s.legalEntityIds.has(le) || (s.own && salesperson === me)
function rights(
  s: Scopes,
  o: { legal_entity_id: string; salesperson_membership_id: string },
  me: string
) {
  const c = (x: PermissionScope) => covers(x, o.legal_entity_id, o.salesperson_membership_id, me)
  const manage = c(s.manage)
  const approve = c(s.approve)
  const fulfil = c(s.fulfil)
  return { read: manage || approve || fulfil || c(s.read), manage, approve, fulfil }
}
type Rights = ReturnType<typeof rights>

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select *, order_date::text as od, requested_date::text as rd from sales_orders where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}
async function authorized(scope: TenantScope, id: string, need: Need, lock = false) {
  const o = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), o, scope.context.membershipId)
  if (!g.read) throw ApiError.notFound()
  if (!g[need])
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      {
        manage: 'Não gere encomendas desta entidade.',
        approve: 'Não aprova encomendas desta entidade.',
        fulfil: 'Não reserva nem expede encomendas desta entidade.',
        read: '',
      }[need]
    )
  return { o, g }
}
const versionCheck = (o: any, expected: unknown) => {
  if (Number(o.version) !== Number(expected)) throw ApiError.versionConflict(Number(o.version))
}
const conflict = (ok: boolean, message: string) => {
  if (!ok) throw ApiError.conflict('INVALID_STATE', message)
}
const reasonOf = (v: unknown) => {
  const r = typeof v === 'string' ? v.trim() : ''
  if (r.length < 3) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r
}

async function event(
  scope: TenantScope,
  id: string,
  kind: string,
  reason: string | null = null,
  details?: Record<string, unknown>
) {
  await scope.trx.rawQuery(
    `insert into sales_order_events (tenant_id, order_id, kind, reason, details, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      id,
      kind,
      reason,
      details ? JSON.stringify(details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}
async function setOrder(scope: TenantScope, id: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields)
  await scope.trx.rawQuery(
    `update sales_orders set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = now(),
       updated_by = ? where tenant_id = ? and id = ?`,
    [...cols.map((c) => fields[c]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function lineRows(scope: TenantScope, id: string, lock = false) {
  return (
    await scope.trx.rawQuery(
      `select * from sales_order_lines where tenant_id = ? and order_id = ? order by line_no${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows as any[]
}
const asQty = (l: any): QtyLine => ({
  isStock: !!l.is_stock,
  quantity: qty(l.quantity),
  reserved: qty(l.reserved_qty),
  delivered: qty(l.delivered_qty),
  invoiced: qty(l.invoiced_qty),
  closed: qty(l.closed_qty),
})

/** Recalcula os estados de reserva, entrega e facturação a partir das linhas. */
async function refreshStatuses(scope: TenantScope, id: string) {
  const lines = (await lineRows(scope, id)).map(asQty)
  await setOrder(scope, id, {
    reservation_status: reservationStatus(lines),
    delivery_status: deliveryStatus(lines),
    invoicing_status: invoicingStatus(lines),
  })
}

async function setLineQty(
  scope: TenantScope,
  lineId: string,
  f: { reserved?: bigint; delivered?: bigint; closed?: bigint }
) {
  const sets: string[] = []
  const params: unknown[] = []
  if (f.reserved !== undefined) (sets.push('reserved_qty = ?'), params.push(qtyText(f.reserved)))
  if (f.delivered !== undefined) (sets.push('delivered_qty = ?'), params.push(qtyText(f.delivered)))
  if (f.closed !== undefined) (sets.push('closed_qty = ?'), params.push(qtyText(f.closed)))
  await scope.trx.rawQuery(
    `update sales_order_lines set ${sets.join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
      where tenant_id = ? and id = ?`,
    [...params, scope.context.userId, scope.context.tenantId, lineId] as never[]
  )
}

/** Tipo de stock das linhas: só produtos armazenáveis passam pelo inventário; kits ainda não são vendidos. */
async function stockFlags(scope: TenantScope, lines: { productId: string }[]) {
  const ids = [...new Set(lines.map((l) => l.productId))]
  if (!ids.length) return new Map<string, boolean>()
  const rows = (
    await scope.trx.rawQuery(
      `select id, product_type from products where tenant_id = ? and id in (${ids.map(() => '?').join(', ')})`,
      [scope.context.tenantId, ...ids]
    )
  ).rows as any[]
  const issues: ErrorDetail[] = []
  lines.forEach((l, i) => {
    const p = rows.find((r) => r.id === l.productId)
    if (p?.product_type === 'KIT')
      issues.push({
        path: `lines.${i}.productId`,
        code: 'KIT_NOT_SUPPORTED',
        message: 'Kits ainda não se vendem: encomende os componentes.',
      })
  })
  fail(issues)
  return new Map(rows.map((r) => [r.id as string, r.product_type === 'STOCKABLE']))
}

/** Grava as linhas (substitui) com preços do motor à data da encomenda; devolve os totais. */
async function writeLines(scope: TenantScope, o: any, lines: LineInput[]) {
  const t = scope.context.tenantId
  const flags = await stockFlags(scope, lines)
  const p = await priced(
    scope,
    {
      customerId: o.customer_id,
      currency: String(o.currency).trim(),
      date: o.od,
      legalEntityId: o.legal_entity_id,
    },
    lines
  )
  await scope.trx.rawQuery(`delete from sales_order_lines where tenant_id = ? and order_id = ?`, [
    t,
    o.id,
  ])
  for (const [i, x] of p.rows.entries())
    await scope.trx.rawQuery(
      `insert into sales_order_lines (tenant_id, order_id, line_no, product_id, variant_id, description, is_stock, quantity,
         manual_discount_pct, manual_unit_price, tax_rate, tax_exemption_reason, price_source, base_price, net_unit_price,
         net_amount, tax_amount, gross_amount, requires_approval, pricing, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        o.id,
        i + 1,
        x.input.productId,
        x.input.variantId,
        x.input.description ?? x.r.name,
        flags.get(x.input.productId) ?? false,
        x.input.quantity,
        x.input.manualDiscountPct,
        x.input.manualUnitPrice,
        x.input.taxRate,
        x.input.taxExemptionReason,
        x.r.source,
        x.r.basePrice,
        x.r.netUnitPrice,
        x.net,
        x.tax,
        x.gross,
        x.r.requiresApproval,
        JSON.stringify(x.r),
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
  await setOrder(scope, o.id, {
    net_total: p.net,
    tax_total: p.tax,
    gross_total: p.gross,
    pricing_hash: p.hash,
  })
  return p
}
async function storedLines(scope: TenantScope, id: string): Promise<LineInput[]> {
  return (await lineRows(scope, id)).map((l) => ({
    productId: l.product_id,
    variantId: l.variant_id ?? null,
    description: l.description,
    quantity: num(l.quantity, QTY_SCALE)!,
    manualDiscountPct: num(l.manual_discount_pct, PCT_SCALE),
    manualUnitPrice: num(l.manual_unit_price, PRICE_SCALE),
    taxRate: num(l.tax_rate, PCT_SCALE)!,
    taxExemptionReason: l.tax_exemption_reason ?? null,
  }))
}

/** Referências do cabeçalho: armazém activo da entidade; morada de entrega activa do cliente. */
async function checkRefs(
  scope: TenantScope,
  le: string,
  customerId: string,
  v: Record<string, unknown>
) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  if (v.warehouseId) {
    const w = (
      await scope.trx.rawQuery(
        `select legal_entity_id, status from warehouses where tenant_id = ? and id = ?`,
        [t, v.warehouseId as string]
      )
    ).rows[0] as any
    if (!w || w.legal_entity_id !== le || w.status !== 'ACTIVE')
      issues.push({
        path: 'warehouseId',
        code: 'NOT_FOUND',
        message: 'Armazém activo inexistente nesta entidade.',
      })
  }
  if (v.deliveryAddressId) {
    const a = (
      await scope.trx.rawQuery(
        `select customer_id, kind, status from customer_addresses where tenant_id = ? and id = ?`,
        [t, v.deliveryAddressId as string]
      )
    ).rows[0] as any
    if (!a || a.customer_id !== customerId || a.kind !== 'DELIVERY' || a.status !== 'ACTIVE')
      issues.push({
        path: 'deliveryAddressId',
        code: 'NOT_FOUND',
        message: 'Morada de entrega activa inexistente neste cliente.',
      })
  }
  fail(issues)
}

/** Série da encomenda: a indicada (da entidade e tipo) ou a única activa; com várias, a escolha é explícita. */
async function seriesFor(scope: TenantScope, le: string, wanted: unknown, on: string) {
  if (wanted !== undefined && wanted !== null && wanted !== '') {
    const f = isUuid(wanted) ? await documentSeriesFacts(scope, wanted as string) : null
    if (!f || f.documentType !== SERIES_TYPE || f.legalEntityId !== le || f.status !== 'ACTIVE')
      fail([
        {
          path: 'seriesId',
          code: 'NOT_FOUND',
          message: 'Série de encomendas inexistente nesta entidade.',
        },
      ])
    return wanted as string
  }
  const ser = (
    await scope.trx.rawQuery(
      `select id, code from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ?
          and status = 'ACTIVE' and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
        order by code`,
      [scope.context.tenantId, le, SERIES_TYPE, on, on]
    )
  ).rows as any[]
  if (!ser.length)
    throw ApiError.conflict(
      'NO_SERIES',
      `Sem série documental ${SERIES_TYPE} activa para a entidade: crie-a em Séries documentais.`
    )
  if (ser.length > 1)
    throw new ApiError(409, 'SERIES_REQUIRED', 'Há várias séries de encomendas: escolha uma.', [
      {
        path: 'seriesId',
        code: 'REQUIRED',
        message: `Escolha a série (${ser.map((x) => x.code).join(', ')}).`,
      },
    ])
  return ser[0].id as string
}

/** Limite de crédito: encomendas confirmadas por facturar do cliente (na moeda do cliente) + esta. */
async function credit(scope: TenantScope, o: any) {
  const c = (
    await scope.trx.rawQuery(
      `select currency, credit_limit from customers where tenant_id = ? and id = ?`,
      [scope.context.tenantId, o.customer_id]
    )
  ).rows[0] as any
  const cur = String(c.currency).trim()
  const rows = (
    await scope.trx.rawQuery(
      `select so.currency, round(sum(l.gross_amount * (l.quantity - l.invoiced_qty - l.closed_qty) / l.quantity), 2)::text as open
         from sales_orders so join sales_order_lines l on l.tenant_id = so.tenant_id and l.order_id = so.id
        where so.tenant_id = ? and so.customer_id = ? and so.status = 'CONFIRMED' and so.id <> ?
        group by so.currency`,
      [scope.context.tenantId, o.customer_id, o.id]
    )
  ).rows as any[]
  const missing: string[] = []
  const toCustomer = async (amount: bigint, from: string) => {
    if (from === cur) return amount
    const r = await rateOn(scope, from, cur, o.od)
    if (!r) {
      missing.push(from)
      return 0n
    }
    // taxa em texto com até 10 casas
    const rate = dbScaled(r.rate, 10)
    return divRound(amount * rate, 10n ** 10n)
  }
  let open = 0n
  for (const r of rows)
    open += await toCustomer(dbScaled(r.open ?? '0', 2), String(r.currency).trim())
  const mine = await toCustomer(dbScaled(o.gross_total, 2), String(o.currency).trim())
  const limit = c.credit_limit === null ? null : dbScaled(c.credit_limit, 2)
  return { ...creditCheck(limit, open, mine), currency: cur, missingRates: [...new Set(missing)] }
}

/** Confirma: número da série, versão imutável dos dados do cliente, estados derivados. */
async function confirm(scope: TenantScope, o: any, approval: 'NOT_REQUIRED' | 'APPROVED') {
  const cust = await customerSnapshot(scope, o.customer_id)
  const number = (await reserveDocumentNumber(scope, o.series_id, today())).formatted
  await setOrder(scope, o.id, {
    status: 'CONFIRMED',
    approval_status: approval,
    number,
    customer_version_id: cust.versionId,
    confirmed_at: new Date(),
    ...(approval === 'APPROVED'
      ? { approved_by: scope.context.userId, approved_at: new Date() }
      : {}),
  })
  await refreshStatuses(scope, o.id)
  await event(scope, o.id, 'CONFIRMED', null, { number, approval })
  return number
}

async function detail(scope: TenantScope, id: string, g?: Rights) {
  const t = scope.context.tenantId
  const o = (
    await scope.trx.rawQuery(
      `select o.*, o.order_date::text as od, o.requested_date::text as rd, le.code as le_code, le.legal_name as le_name,
              bp.code as cus_code, bp.name as cus_name, c.status as cus_status, u.full_name as sp_name,
              w.code as wh_code, w.name as wh_name, q.number as q_number, q.version_no as q_version,
              a.label as addr_label, a.address_line as addr_line
         from sales_orders o
         join legal_entities le on le.tenant_id = o.tenant_id and le.id = o.legal_entity_id
         join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
         join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
         join tenant_memberships m on m.tenant_id = o.tenant_id and m.id = o.salesperson_membership_id
         join users u on u.id = m.user_id
         left join warehouses w on w.tenant_id = o.tenant_id and w.id = o.warehouse_id
         left join sales_quotes q on q.tenant_id = o.tenant_id and q.id = o.quote_id
         left join customer_addresses a on a.tenant_id = o.tenant_id and a.id = o.delivery_address_id
        where o.tenant_id = ? and o.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!o) throw ApiError.notFound()
  const lines = (
    await scope.trx.rawQuery(
      `select l.*, p.sku, v.sku as variant_sku from sales_order_lines l
         join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         left join product_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
        where l.tenant_id = ? and l.order_id = ? order by l.line_no`,
      [t, id]
    )
  ).rows as any[]
  const deliveries = (
    await scope.trx.rawQuery(
      `select d.*, d.delivery_date::text as dd, u.full_name,
              (select json_agg(json_build_object('lineNo', l.line_no, 'quantity', dl.quantity::text) order by l.line_no)
                 from sales_order_delivery_lines dl join sales_order_lines l on l.tenant_id = dl.tenant_id and l.id = dl.order_line_id
                where dl.tenant_id = d.tenant_id and dl.delivery_id = d.id) as lines
         from sales_order_deliveries d left join users u on u.id = d.created_by
        where d.tenant_id = ? and d.order_id = ? order by d.seq`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from sales_order_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.order_id = ? order by e.created_at, e.id`,
      [t, id]
    )
  ).rows as any[]
  const a = g ?? rights(await scopesOf(scope), o, scope.context.membershipId)
  const q = lines.map(asQty)
  const anyOpen = q.some((l) => openQty(l) > 0n)
  const toReserve = q.some((l) => l.isStock && openQty(l) > (l.reserved as bigint))
  const anyReserved = q.some((l) => (l.reserved as bigint) > 0n)
  const anyDelivered = q.some((l) => (l.delivered as bigint) > 0n)
  const draft = o.status === 'DRAFT'
  const confirmed = o.status === 'CONFIRMED'
  const pending = o.approval_status === 'PENDING'
  return {
    id: o.id as string,
    version: Number(o.version),
    number: (o.number as string) ?? null,
    status: o.status as string,
    approvalStatus: o.approval_status as string,
    reservationStatus: o.reservation_status as string,
    deliveryStatus: o.delivery_status as string,
    invoicingStatus: o.invoicing_status as string,
    approvalReasons: (o.approval_reasons as string[]) ?? [],
    creditCheck: (o.credit_check as Record<string, unknown>) ?? null,
    legalEntity: {
      id: o.legal_entity_id as string,
      code: o.le_code as string,
      name: o.le_name as string,
    },
    customer: {
      id: o.customer_id as string,
      code: o.cus_code as string,
      name: o.cus_name as string,
      status: o.cus_status as string,
    },
    salesperson: { membershipId: o.salesperson_membership_id as string, name: o.sp_name as string },
    warehouse: o.warehouse_id
      ? { id: o.warehouse_id as string, code: o.wh_code as string, name: o.wh_name as string }
      : null,
    deliveryAddress: o.delivery_address_id
      ? {
          id: o.delivery_address_id as string,
          label: o.addr_label as string,
          line: o.addr_line as string,
        }
      : null,
    quote: o.quote_id
      ? { id: o.quote_id as string, number: o.q_number as string, versionNo: Number(o.q_version) }
      : null,
    orderDate: o.od as string,
    requestedDate: (o.rd as string) ?? null,
    currency: String(o.currency).trim(),
    paymentTermsDays: Number(o.payment_terms_days),
    customerReference: (o.customer_reference as string) ?? null,
    notes: (o.notes as string) ?? null,
    netTotal: money(o.net_total),
    taxTotal: money(o.tax_total),
    grossTotal: money(o.gross_total),
    closedReason: (o.closed_reason as string) ?? null,
    lines: lines.map((l, i) => ({
      id: l.id as string,
      version: Number(l.version),
      lineNo: Number(l.line_no),
      product: { id: l.product_id as string, sku: l.sku as string },
      variant: l.variant_id ? { id: l.variant_id as string, sku: l.variant_sku as string } : null,
      description: l.description as string,
      isStock: !!l.is_stock,
      quantity: num(l.quantity, QTY_SCALE)!,
      reservedQty: num(l.reserved_qty, QTY_SCALE)!,
      deliveredQty: num(l.delivered_qty, QTY_SCALE)!,
      invoicedQty: num(l.invoiced_qty, QTY_SCALE)!,
      closedQty: num(l.closed_qty, QTY_SCALE)!,
      openQty: qtyText(openQty(q[i])),
      manualDiscountPct: num(l.manual_discount_pct, PCT_SCALE),
      manualUnitPrice: num(l.manual_unit_price, PRICE_SCALE),
      taxRate: num(l.tax_rate, PCT_SCALE)!,
      taxExemptionReason: (l.tax_exemption_reason as string) ?? null,
      priceSource: l.price_source as string,
      basePrice: num(l.base_price, PRICE_SCALE),
      netUnitPrice: num(l.net_unit_price, PRICE_SCALE),
      netAmount: money(l.net_amount),
      taxAmount: money(l.tax_amount),
      grossAmount: money(l.gross_amount),
      requiresApproval: !!l.requires_approval,
      pricing: l.pricing as Record<string, unknown>,
      quoteLineNo: l.quote_line_no === null ? null : Number(l.quote_line_no),
    })),
    deliveries: deliveries.map((d) => ({
      id: d.id as string,
      seq: Number(d.seq),
      reference: d.reference as string,
      deliveryDate: d.dd as string,
      stockEventId: (d.stock_event_id as string) ?? null,
      notes: (d.notes as string) ?? null,
      lines: ((d.lines as any[]) ?? []).map((x) => ({
        lineNo: Number(x.lineNo),
        quantity: scaledText(dbScaled(x.quantity, QTY_SCALE), QTY_SCALE),
      })),
      at: new Date(d.created_at).toISOString(),
      by: (d.full_name as string) ?? null,
    })),
    history: events.map((e) => ({
      kind: e.kind as string,
      reason: (e.reason as string) ?? null,
      details: (e.details as Record<string, unknown>) ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: {
      edit: a.manage && draft && !pending,
      editLines: a.manage && draft && !pending && !o.quote_id,
      submit: a.manage && draft && !pending,
      approve: a.approve && draft && pending && o.submitted_by !== scope.context.userId,
      reject: a.approve && draft && pending,
      reserve: a.fulfil && confirmed && toReserve,
      release: a.fulfil && confirmed && anyReserved,
      deliver: a.fulfil && confirmed && anyOpen,
      close: a.manage && confirmed && anyDelivered && anyOpen,
      cancel: a.manage && (draft || (confirmed && !anyDelivered)),
    },
  }
}
export type OrderView = Awaited<ReturnType<typeof detail>>

export class OrderService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      approvalStatus?: string
      deliveryStatus?: string
      customerId?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const all = Object.values(s)
      const where = ['o.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!all.some((x) => x.tenant)) {
        const les = [...new Set(all.flatMap((x) => [...x.legalEntityIds]))]
        const own = all.some((x) => x.own)
        if (!les.length && !own)
          throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar encomendas.')
        const or: string[] = []
        if (les.length) {
          or.push(`o.legal_entity_id in (${les.map(() => '?').join(', ')})`)
          params.push(...les)
        }
        if (own) {
          or.push('o.salesperson_membership_id = ?')
          params.push(context.membershipId)
        }
        where.push(`(${or.join(' or ')})`)
      }
      if (f.status && (ORDER_STATUSES as readonly string[]).includes(f.status))
        (where.push('o.status = ?'), params.push(f.status))
      if (f.approvalStatus) (where.push('o.approval_status = ?'), params.push(f.approvalStatus))
      if (f.deliveryStatus) (where.push('o.delivery_status = ?'), params.push(f.deliveryStatus))
      if (f.customerId && isUuid(f.customerId))
        (where.push('o.customer_id = ?'), params.push(f.customerId))
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(o.number, '')) like ? or lower(bp.code) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like)
      }
      const from = `from sales_orders o
        join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
        join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
        join legal_entities le on le.tenant_id = o.tenant_id and le.id = o.legal_entity_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select o.*, o.order_date::text as od, o.requested_date::text as rd, bp.code as cus_code, bp.name as cus_name,
                  le.code as le_code ${from} order by o.created_at desc, o.id limit ? offset ?`,
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
        items: rows.map((o) => ({
          id: o.id as string,
          number: (o.number as string) ?? null,
          customer: { code: o.cus_code as string, name: o.cus_name as string },
          legalEntity: o.le_code as string,
          orderDate: o.od as string,
          requestedDate: (o.rd as string) ?? null,
          currency: String(o.currency).trim(),
          grossTotal: money(o.gross_total),
          status: o.status as string,
          approvalStatus: o.approval_status as string,
          reservationStatus: o.reservation_status as string,
          deliveryStatus: o.delivery_status as string,
          invoicingStatus: o.invoicing_status as string,
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
      const s = await scopesOf(scope)
      const t = context.tenantId
      const les = (
        await scope.trx.rawQuery(
          `select id, code, legal_name, status from legal_entities where tenant_id = ? order by code`,
          [t]
        )
      ).rows as any[]
      const manageable = les.filter(
        (l) =>
          l.status === 'ACTIVE' &&
          (s.manage.tenant || s.manage.legalEntityIds.has(l.id) || s.manage.own)
      )
      const warehouses = (
        await scope.trx.rawQuery(
          `select id, code, name, legal_entity_id from warehouses where tenant_id = ? and status = 'ACTIVE' order by code`,
          [t]
        )
      ).rows as any[]
      const people = (
        await scope.trx.rawQuery(
          `select m.id, u.full_name from tenant_memberships m join users u on u.id = m.user_id
            where m.tenant_id = ? and m.status = 'ACTIVE' order by u.full_name`,
          [t]
        )
      ).rows as any[]
      const series = (
        await scope.trx.rawQuery(
          `select id, code, prefix, legal_entity_id from document_series where tenant_id = ? and document_type = ? and status = 'ACTIVE' order by code`,
          [t, SERIES_TYPE]
        )
      ).rows as any[]
      return {
        legalEntities: manageable.map((l) => ({
          id: l.id as string,
          code: l.code as string,
          name: l.legal_name as string,
        })),
        warehouses: warehouses.map((w) => ({
          id: w.id as string,
          code: w.code as string,
          name: w.name as string,
          legalEntityId: w.legal_entity_id as string,
        })),
        salespeople: people.map((p) => ({
          membershipId: p.id as string,
          name: p.full_name as string,
        })),
        series: series.map((x) => ({
          id: x.id as string,
          code: x.code as string,
          prefix: x.prefix as string,
          legalEntityId: x.legal_entity_id as string,
        })),
        ownOnly: !s.manage.tenant && s.manage.legalEntityIds.size === 0 && s.manage.own,
      }
    })
  }

  /** Moradas de entrega activas de um cliente (para o formulário). */
  addresses(context: TenantContext, customerId: string) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!(s.manage.tenant || s.manage.own || s.manage.legalEntityIds.size))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere encomendas.')
      if (!isUuid(customerId) || !(await customerRow(scope, customerId))) throw ApiError.notFound()
      const rows = (
        await scope.trx.rawQuery(
          `select id, label, address_line, is_default from customer_addresses where tenant_id = ? and customer_id = ?
              and kind = 'DELIVERY' and status = 'ACTIVE' order by is_default desc, label`,
          [context.tenantId, customerId]
        )
      ).rows as any[]
      return rows.map((a) => ({
        id: a.id as string,
        label: a.label as string,
        line: a.address_line as string,
        isDefault: !!a.is_default,
      }))
    })
  }

  search(context: TenantContext, kind: 'customers' | 'products', q: string) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!(s.manage.tenant || s.manage.own || s.manage.legalEntityIds.size))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere encomendas.')
      return searchSalesRefs(scope, kind, q)
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, issues } = normalizeOrderHeader(input, true)
      const nl = normalizeLines(input.lines ?? [])
      fail([...issues, ...nl.issues])
      const le = await legalEntityFacts(scope, v.legalEntityId as string)
      if (!le)
        fail([{ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' }])
      const salesperson = (v.salespersonMembershipId as string | null) ?? context.membershipId
      const s = await scopesOf(scope)
      if (!covers(s.manage, le!.id, salesperson, context.membershipId))
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          'Não gere encomendas desta entidade (ou de outro comercial).'
        )
      conflict(le!.status === 'ACTIVE', 'A entidade legal não está activa.')
      await salespersonOk(scope, salesperson)
      const c = await customerRow(scope, v.customerId as string)
      if (!c) fail([{ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' }])
      customerActive(c)
      await checkRefs(scope, le!.id, c.id, v)
      const ins = await scope.trx.rawQuery(
        `insert into sales_orders (tenant_id, legal_entity_id, customer_id, salesperson_membership_id, warehouse_id,
           delivery_address_id, order_date, requested_date, currency, payment_terms_days, customer_reference, notes,
           created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          le!.id,
          c.id,
          salesperson,
          v.warehouseId ?? null,
          v.deliveryAddressId ?? null,
          v.orderDate,
          v.requestedDate ?? null,
          (v.currency as string) ?? String(c.currency).trim(),
          (v.paymentTermsDays as number) ?? Number(c.payment_terms_days),
          v.customerReference ?? null,
          v.notes ?? null,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as any).id as string
      const p = await writeLines(scope, await load(scope, id), nl.lines)
      await event(scope, id, 'CREATED')
      await audit(scope, {
        action: 'sales_order.created',
        entityType: 'sales_order',
        entityId: id,
        changes: { customerId: { from: null, to: c.id }, grossTotal: { from: null, to: p.gross } },
      })
      return detail(scope, id)
    })
  }

  /** Converte um orçamento aceite (uma única vez): cabeçalho e linhas com os preços aceites pelo cliente. */
  fromQuote(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const quoteId = input.quoteId
      if (!isUuid(quoteId)) fail([{ path: 'quoteId', code: 'REQUIRED', message: 'Orçamento.' }])
      const { v, issues } = normalizeOrderHeader(
        {
          orderDate: input.orderDate ?? today(),
          ...Object.fromEntries(
            ['warehouseId', 'deliveryAddressId', 'requestedDate', 'notes']
              .filter((k) => k in input)
              .map((k) => [k, input[k]])
          ),
        },
        false
      )
      fail(issues)
      const a = await acceptedQuote(scope, quoteId as string)
      const qt = a.quote
      const s = await scopesOf(scope)
      if (!covers(s.manage, qt.legalEntity.id, qt.salesperson.membershipId, context.membershipId))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere encomendas desta entidade.')
      const c = await customerRow(scope, qt.customer.id)
      customerActive(c)
      await checkRefs(scope, qt.legalEntity.id, c.id, v)
      const ins = await scope.trx.rawQuery(
        `insert into sales_orders (tenant_id, legal_entity_id, customer_id, salesperson_membership_id, warehouse_id,
           delivery_address_id, quote_id, order_date, requested_date, currency, payment_terms_days, customer_reference,
           notes, net_total, tax_total, gross_total, pricing_hash, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          qt.legalEntity.id,
          qt.customer.id,
          qt.salesperson.membershipId,
          v.warehouseId ?? null,
          v.deliveryAddressId ?? null,
          qt.id,
          v.orderDate,
          v.requestedDate ?? null,
          qt.currency,
          qt.paymentTermsDays,
          (a.quote.history.at(-1)?.details?.customerReference as string) ?? qt.customerReference,
          v.notes ?? qt.notes,
          qt.netTotal,
          qt.taxTotal,
          qt.grossTotal,
          a.versionHash,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as any).id as string
      const flags = await stockFlags(
        scope,
        qt.lines.map((l) => ({ productId: l.product.id }))
      )
      for (const l of qt.lines)
        await scope.trx.rawQuery(
          `insert into sales_order_lines (tenant_id, order_id, line_no, product_id, variant_id, description, is_stock,
             quantity, manual_discount_pct, manual_unit_price, tax_rate, tax_exemption_reason, price_source, base_price,
             net_unit_price, net_amount, tax_amount, gross_amount, requires_approval, pricing, quote_line_no, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?, ?, ?)`,
          [
            context.tenantId,
            id,
            l.lineNo,
            l.product.id,
            l.variant?.id ?? null,
            l.description,
            flags.get(l.product.id) ?? false,
            l.quantity,
            l.manualDiscountPct,
            l.manualUnitPrice,
            l.taxRate,
            l.taxExemptionReason,
            l.priceSource,
            l.basePrice,
            l.netUnitPrice,
            l.netAmount,
            l.taxAmount,
            l.grossAmount,
            JSON.stringify(l.pricing),
            l.lineNo,
            context.userId,
            context.userId,
          ] as never[]
        )
      await markQuoteConverted(scope, qt.id, id)
      await event(scope, id, 'CREATED_FROM_QUOTE', null, {
        quote: qt.number,
        versionNo: qt.versionNo,
        versionHash: a.versionHash,
      })
      await audit(scope, {
        action: 'sales_order.created',
        entityType: 'sales_order',
        entityId: id,
        changes: {
          quoteId: { from: null, to: qt.id },
          grossTotal: { from: null, to: qt.grossTotal },
        },
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      conflict(
        o.status === 'DRAFT' && o.approval_status !== 'PENDING',
        'Só se altera em rascunho (e não durante a aprovação).'
      )
      const { expectedVersion, lines: rawLines, legalEntityId, ...rest } = input
      for (const k of ['customerId', 'currency', 'paymentTermsDays'])
        if (o.quote_id && k in rest)
          fail([
            { path: k, code: 'NOT_ALLOWED', message: 'Vem do orçamento aceite e não se altera.' },
          ])
      if (o.quote_id && rawLines !== undefined)
        throw ApiError.conflict(
          'LINES_FROM_QUOTE',
          'As linhas vêm do orçamento aceite e não se alteram.'
        )
      const { v, issues } = normalizeOrderHeader(rest, false)
      const od = (v.orderDate as string) ?? o.od
      const rd = 'requestedDate' in v ? (v.requestedDate as string | null) : o.rd
      if (rd && rd < od)
        issues.push({
          path: 'requestedDate',
          code: 'INVALID',
          message: 'A entrega pedida não pode ser antes da encomenda.',
        })
      const nl = rawLines === undefined ? null : normalizeLines(rawLines)
      fail([...issues, ...(nl?.issues ?? [])])
      if (v.salespersonMembershipId === null) delete v.salespersonMembershipId
      if (v.salespersonMembershipId) {
        const s = await scopesOf(scope)
        if (
          !covers(
            s.manage,
            o.legal_entity_id,
            v.salespersonMembershipId as string,
            context.membershipId
          )
        )
          throw ApiError.forbidden(
            'OUT_OF_SCOPE',
            'Não pode atribuir a encomenda a outro comercial.'
          )
        await salespersonOk(scope, v.salespersonMembershipId as string)
      }
      const customerId = (v.customerId as string) ?? o.customer_id
      if (v.customerId && v.customerId !== o.customer_id) {
        const c = await customerRow(scope, v.customerId as string)
        if (!c) fail([{ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' }])
        customerActive(c)
      }
      await checkRefs(scope, o.legal_entity_id, customerId, v)
      const map: Record<string, string> = {
        customerId: 'customer_id',
        salespersonMembershipId: 'salesperson_membership_id',
        warehouseId: 'warehouse_id',
        deliveryAddressId: 'delivery_address_id',
        orderDate: 'order_date',
        requestedDate: 'requested_date',
        currency: 'currency',
        paymentTermsDays: 'payment_terms_days',
        customerReference: 'customer_reference',
        notes: 'notes',
      }
      const fields: Record<string, unknown> = {
        approval_status: 'NOT_REQUIRED',
        approval_reasons: '{}',
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const [k, col] of Object.entries(map))
        if (k in v) {
          fields[col] = v[k]
          changes[k] = {
            from: col === 'order_date' ? o.od : col === 'requested_date' ? o.rd : o[col],
            to: v[k],
          }
        }
      await setOrder(scope, id, fields)
      if (!o.quote_id) {
        const p = await writeLines(
          scope,
          await load(scope, id),
          nl ? nl.lines : await storedLines(scope, id)
        )
        changes.grossTotal = { from: money(o.gross_total), to: p.gross }
      }
      await audit(scope, {
        action: 'sales_order.updated',
        entityType: 'sales_order',
        entityId: id,
        changes,
      })
      return detail(scope, id)
    })
  }

  /** Submeter: preços (sem orçamento) e crédito verificados; sem excepções confirma logo, senão aguarda aprovação. */
  submit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      conflict(
        o.status === 'DRAFT' && o.approval_status !== 'PENDING',
        'Só se submete um rascunho.'
      )
      customerActive(await customerRow(scope, o.customer_id))
      let lines = await lineRows(scope, id)
      if (!lines.length) throw ApiError.conflict('NO_LINES', 'A encomenda não tem linhas.')
      let pricing = false
      if (!o.quote_id) {
        const p = await writeLines(scope, o, await storedLines(scope, id))
        if (p.missing)
          throw ApiError.conflict(
            'NO_PRICE',
            'Há linhas sem preço: indique um preço manual ou crie a tabela.'
          )
        pricing = p.requiresApproval
        lines = await lineRows(scope, id)
      }
      if (lines.some((l) => l.is_stock) && !o.warehouse_id)
        fail([
          {
            path: 'warehouseId',
            code: 'REQUIRED',
            message: 'Escolha o armazém de onde sai a mercadoria.',
          },
        ])
      const seriesId = await seriesFor(scope, o.legal_entity_id, input.seriesId, today())
      const cur = await load(scope, id, true)
      const check = await credit(scope, cur)
      const reasons = [
        ...(pricing ? ['PRICING'] : []),
        ...(check.exceeded ? ['CREDIT'] : []),
        ...(check.missingRates.length ? ['NO_RATE'] : []),
      ]
      await setOrder(scope, id, {
        series_id: seriesId,
        credit_check: JSON.stringify(check),
        approval_reasons: `{${reasons.join(',')}}`,
        approval_status: reasons.length ? 'PENDING' : 'NOT_REQUIRED',
        submitted_by: context.userId,
        submitted_at: new Date(),
      })
      await event(scope, id, 'SUBMITTED', null, { reasons, credit: check })
      let number: string | null = null
      if (!reasons.length) number = await confirm(scope, await load(scope, id), 'NOT_REQUIRED')
      await audit(scope, {
        action: 'sales_order.submitted',
        entityType: 'sales_order',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: number ? 'CONFIRMED' : 'DRAFT' } },
        metadata: { reasons, exposure: check.exposure, limit: check.limit },
      })
      return detail(scope, id)
    })
  }

  approve(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'approve', true)
      versionCheck(o, input.expectedVersion)
      conflict(
        o.status === 'DRAFT' && o.approval_status === 'PENDING',
        'Só se aprova uma encomenda a aguardar aprovação.'
      )
      if (o.submitted_by === context.userId)
        throw ApiError.forbidden('SELF_APPROVAL', 'Quem submete não aprova a própria encomenda.')
      customerActive(await customerRow(scope, o.customer_id))
      const number = await confirm(scope, o, 'APPROVED')
      await event(scope, id, 'APPROVED', null, { reasons: o.approval_reasons })
      await audit(scope, {
        action: 'sales_order.approved',
        entityType: 'sales_order',
        entityId: id,
        changes: { status: { from: 'DRAFT', to: 'CONFIRMED' } },
        metadata: { number, reasons: o.approval_reasons },
      })
      return detail(scope, id)
    })
  }

  reject(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'approve', true)
      versionCheck(o, input.expectedVersion)
      conflict(
        o.status === 'DRAFT' && o.approval_status === 'PENDING',
        'Só se devolve uma encomenda a aguardar aprovação.'
      )
      const reason = reasonOf(input.reason)
      await setOrder(scope, id, {
        approval_status: 'REJECTED',
        submitted_by: null,
        submitted_at: null,
      })
      await event(scope, id, 'REJECTED', reason)
      await audit(scope, {
        action: 'sales_order.rejected',
        entityType: 'sales_order',
        entityId: id,
        changes: { approvalStatus: { from: 'PENDING', to: 'REJECTED' } },
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }

  /** Reservar no Inventário o que falta (ou as quantidades pedidas por linha). */
  reserve(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'fulfil', true)
      versionCheck(o, input.expectedVersion)
      conflict(o.status === 'CONFIRMED', 'Só se reserva uma encomenda confirmada.')
      const r = normalizeQtyRequest(input)
      fail(r.issues)
      const lines = await lineRows(scope, id, true)
      const wanted = new Map<string, bigint>()
      const issues: ErrorDetail[] = []
      const free = (l: any) => openQty(asQty(l)) - qty(l.reserved_qty)
      if (r.lines.length)
        r.lines.forEach((x, i) => {
          const l = lines.find((y) => y.id === x.lineId)
          if (!l)
            issues.push({
              path: `lines.${i}.lineId`,
              code: 'NOT_FOUND',
              message: 'Linha inexistente nesta encomenda.',
            })
          else if (!l.is_stock)
            issues.push({
              path: `lines.${i}.lineId`,
              code: 'NOT_STOCK',
              message: 'Serviços não se reservam.',
            })
          else if (x.quantity + (wanted.get(l.id) ?? 0n) > free(l))
            issues.push({
              path: `lines.${i}.quantity`,
              code: 'OVER_RESERVE',
              message: `Só faltam reservar ${qtyText(free(l))}.`,
            })
          else wanted.set(l.id, (wanted.get(l.id) ?? 0n) + x.quantity)
        })
      else for (const l of lines) if (l.is_stock && free(l) > 0n) wanted.set(l.id, free(l))
      fail(issues)
      if (!wanted.size) throw ApiError.conflict('NOTHING_TO_RESERVE', 'Não há nada por reservar.')
      const seq = Number(o.reservation_seq) + 1
      const customer = await customerRow(scope, o.customer_id)
      const ev = await reserveForSale(scope, {
        idempotencyKey: `so-${id}-r${seq}`,
        warehouseId: o.warehouse_id,
        orderRef: o.number,
        counterpartyRef: customer.code,
        lines: [...wanted].map(([lineId, quantity]) => {
          const l = lines.find((y) => y.id === lineId)!
          return { productId: l.product_id, variantId: l.variant_id, quantity: qtyText(quantity) }
        }),
      })
      for (const [lineId, quantity] of wanted) {
        const l = lines.find((y) => y.id === lineId)!
        await setLineQty(scope, lineId, { reserved: qty(l.reserved_qty) + quantity })
      }
      await setOrder(scope, id, { reservation_seq: seq })
      await refreshStatuses(scope, id)
      await event(scope, id, 'RESERVED', null, {
        stockEventId: ev.id,
        lines: [...wanted].map(([l, x]) => ({ lineId: l, quantity: qtyText(x) })),
      })
      await audit(scope, {
        action: 'sales_order.reserved',
        entityType: 'sales_order',
        entityId: id,
        metadata: { stockEventId: ev.id },
      })
      return detail(scope, id)
    })
  }

  release(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'fulfil', true)
      versionCheck(o, input.expectedVersion)
      conflict(o.status === 'CONFIRMED', 'Só se liberta uma encomenda confirmada.')
      const r = normalizeQtyRequest(input)
      fail(r.issues)
      const ev = await releaseLines(scope, o, r.lines.length ? r.lines : null)
      await refreshStatuses(scope, id)
      await event(scope, id, 'RELEASED', null, { stockEventId: ev })
      await audit(scope, {
        action: 'sales_order.released',
        entityType: 'sales_order',
        entityId: id,
        metadata: { stockEventId: ev },
      })
      return detail(scope, id)
    })
  }

  /**
   * Expedir: linhas e quantidades até ao que falta; as de stock saem do Inventário (consumindo a reserva), os serviços
   * dão-se por prestados. Idempotente pela chave do pedido.
   */
  deliver(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'fulfil', true)
      const d = normalizeDelivery(input)
      fail(d.issues)
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            d: d.date,
            n: d.notes,
            l: d.lines.map((l) => [l.lineId, qtyText(l.quantity), l.serials]),
          })
        )
        .digest('hex')
      const prev = (
        await scope.trx.rawQuery(
          `select request_hash from sales_order_deliveries where tenant_id = ? and order_id = ? and request_key = ?`,
          [context.tenantId, id, d.key]
        )
      ).rows[0] as any
      if (prev) {
        if (prev.request_hash !== hash)
          throw ApiError.conflict(
            'IDEMPOTENCY_MISMATCH',
            'Esta chave já foi usada numa expedição diferente.'
          )
        return detail(scope, id)
      }
      versionCheck(o, input.expectedVersion)
      conflict(o.status === 'CONFIRMED', 'Só se expede uma encomenda confirmada.')
      customerActive(await customerRow(scope, o.customer_id))
      const lines = await lineRows(scope, id, true)
      const per = new Map<string, bigint>()
      const issues: ErrorDetail[] = []
      d.lines.forEach((x, i) => {
        const l = lines.find((y) => y.id === x.lineId)
        if (!l)
          return issues.push({
            path: `lines.${i}.lineId`,
            code: 'NOT_FOUND',
            message: 'Linha inexistente nesta encomenda.',
          })
        const total = (per.get(l.id) ?? 0n) + x.quantity
        const open = openQty(asQty(l))
        if (total > open)
          issues.push({
            path: `lines.${i}.quantity`,
            code: 'OVER_DELIVERY',
            message: `Só faltam ${qtyText(open)} desta linha.`,
          })
        per.set(l.id, total)
      })
      fail(issues)
      const seq =
        Number(
          (
            (
              await scope.trx.rawQuery(
                `select count(*)::int as n from sales_order_deliveries where tenant_id = ? and order_id = ?`,
                [context.tenantId, id]
              )
            ).rows[0] as any
          ).n
        ) + 1
      const reference = `${o.number}/E${seq}`
      const stock = d.lines.filter((x) => lines.find((y) => y.id === x.lineId)!.is_stock)
      let stockEventId: string | null = null
      if (stock.length) {
        const customer = await customerRow(scope, o.customer_id)
        const ev = await deliverSale(scope, {
          idempotencyKey: `so-${id}-d-${d.key}`.slice(0, 100),
          warehouseId: o.warehouse_id,
          orderRef: o.number,
          documentRef: reference,
          counterpartyRef: customer.code,
          lines: stock.map((x) => {
            const l = lines.find((y) => y.id === x.lineId)!
            return {
              productId: l.product_id,
              variantId: l.variant_id,
              quantity: qtyText(x.quantity),
              serials: x.serials.length ? x.serials : null,
            }
          }),
        })
        stockEventId = ev.id
      }
      const ins = await scope.trx.rawQuery(
        `insert into sales_order_deliveries (tenant_id, order_id, seq, reference, request_key, request_hash, delivery_date,
           warehouse_id, stock_event_id, notes, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          id,
          seq,
          reference,
          d.key,
          hash,
          d.date,
          stock.length ? o.warehouse_id : null,
          stockEventId,
          d.notes,
          context.userId,
          context.userId,
        ] as never[]
      )
      const deliveryId = (ins.rows[0] as any).id as string
      for (const x of d.lines)
        await scope.trx.rawQuery(
          `insert into sales_order_delivery_lines (tenant_id, delivery_id, order_line_id, quantity, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            deliveryId,
            x.lineId,
            qtyText(x.quantity),
            context.userId,
            context.userId,
          ] as never[]
        )
      // A entrega consome a reserva da linha (como o Inventário consome a da encomenda).
      for (const [lineId, quantity] of per) {
        const l = lines.find((y) => y.id === lineId)!
        const reserved = qty(l.reserved_qty)
        const used = reserved < quantity ? reserved : quantity
        await setLineQty(scope, lineId, {
          delivered: qty(l.delivered_qty) + quantity,
          reserved: reserved - used,
        })
      }
      await refreshStatuses(scope, id)
      await event(scope, id, 'DELIVERED', null, { reference, stockEventId })
      await audit(scope, {
        action: 'sales_order.delivered',
        entityType: 'sales_order',
        entityId: id,
        metadata: { reference, stockEventId },
      })
      return detail(scope, id)
    })
  }

  /** Fechar o resto: liberta as reservas e dá por fechado o que falta entregar, com motivo. */
  close(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      conflict(o.status === 'CONFIRMED', 'Só se fecha uma encomenda confirmada.')
      const reason = reasonOf(input.reason)
      const lines = await lineRows(scope, id, true)
      if (!lines.some((l) => qty(l.delivered_qty) > 0n))
        throw ApiError.conflict('NOTHING_DELIVERED', 'Sem entregas: anule a encomenda.')
      if (lines.some((l) => qty(l.reserved_qty) > 0n)) await releaseLines(scope, o, null)
      for (const l of await lineRows(scope, id, true)) {
        const open = openQty(asQty(l))
        if (open > 0n) await setLineQty(scope, l.id, { closed: qty(l.closed_qty) + open })
      }
      await refreshStatuses(scope, id)
      await setOrder(scope, id, { status: 'CLOSED', closed_reason: reason })
      await event(scope, id, 'CLOSED', reason)
      await audit(scope, {
        action: 'sales_order.closed',
        entityType: 'sales_order',
        entityId: id,
        changes: { status: { from: 'CONFIRMED', to: 'CLOSED' } },
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }

  /** Anular (rascunho, ou confirmada sem entregas): liberta as reservas. O orçamento de origem continua convertido. */
  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      const lines = await lineRows(scope, id, true)
      conflict(
        o.status === 'DRAFT' ||
          (o.status === 'CONFIRMED' && !lines.some((l) => qty(l.delivered_qty) > 0n)),
        'Só se anula um rascunho ou uma encomenda confirmada sem entregas.'
      )
      const reason = reasonOf(input.reason)
      if (lines.some((l) => qty(l.reserved_qty) > 0n)) await releaseLines(scope, o, null)
      await refreshStatuses(scope, id)
      await setOrder(scope, id, {
        status: 'CANCELLED',
        closed_reason: reason,
        ...(o.approval_status === 'PENDING' ? { approval_status: 'REJECTED' } : {}),
      })
      await event(scope, id, 'CANCELLED', reason)
      await audit(scope, {
        action: 'sales_order.cancelled',
        entityType: 'sales_order',
        entityId: id,
        changes: { status: { from: o.status, to: 'CANCELLED' } },
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }
}

/** Liberta no Inventário (as linhas pedidas, ou todas) e acerta o reservado das linhas; devolve o evento. */
async function releaseLines(
  scope: TenantScope,
  o: any,
  wanted: { lineId: string; quantity: bigint }[] | null
) {
  const lines = await lineRows(scope, o.id, true)
  const issues: ErrorDetail[] = []
  const per = new Map<string, bigint>()
  if (wanted)
    wanted.forEach((x, i) => {
      const l = lines.find((y) => y.id === x.lineId)
      if (!l)
        return issues.push({
          path: `lines.${i}.lineId`,
          code: 'NOT_FOUND',
          message: 'Linha inexistente nesta encomenda.',
        })
      const total = (per.get(l.id) ?? 0n) + x.quantity
      if (total > qty(l.reserved_qty))
        issues.push({
          path: `lines.${i}.quantity`,
          code: 'OVER_RELEASE',
          message: `A linha só tem ${qtyText(qty(l.reserved_qty))} reservado.`,
        })
      per.set(l.id, total)
    })
  else for (const l of lines) if (qty(l.reserved_qty) > 0n) per.set(l.id, qty(l.reserved_qty))
  fail(issues)
  if (!per.size) throw ApiError.conflict('NOTHING_RESERVED', 'Não há nada reservado.')
  const seq = Number(o.reservation_seq) + 1
  const ev = await releaseSaleReservation(scope, {
    idempotencyKey: `so-${o.id}-l${seq}`,
    warehouseId: o.warehouse_id,
    orderRef: o.number,
    lines: [...per].map(([lineId, quantity]) => {
      const l = lines.find((y) => y.id === lineId)!
      return { productId: l.product_id, variantId: l.variant_id, quantity: qtyText(quantity) }
    }),
  })
  for (const [lineId, quantity] of per) {
    const l = lines.find((y) => y.id === lineId)!
    await setLineQty(scope, lineId, { reserved: qty(l.reserved_qty) - quantity })
  }
  await setOrder(scope, o.id, { reservation_seq: seq })
  return ev.id as string
}

/** Acesso aos anexos da encomenda (nota de encomenda do cliente, comprovativos de entrega). */
export async function orderAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const o = (
    await scope.trx.rawQuery(
      `select legal_entity_id, salesperson_membership_id from sales_orders where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!o) return null
  const g = rights(await scopesOf(scope), o, scope.context.membershipId)
  return g.read ? { read: true, write: g.manage || g.fulfil } : null
}

// ---------------------------------------------------------------------------------------------------------------
// Contratos para a facturação (10.6)
// ---------------------------------------------------------------------------------------------------------------

/** Encomenda (confirmada ou fechada) e, por linha, o que está entregue e ainda por facturar, com o preço acordado. */
export async function invoiceableOrder(scope: TenantScope, orderId: string) {
  const o = await load(scope, orderId)
  if (!['CONFIRMED', 'CLOSED'].includes(o.status))
    throw ApiError.conflict('INVALID_STATE', 'Só se factura uma encomenda confirmada ou fechada.')
  const lines = (await lineRows(scope, orderId)).map((l) => {
    const pending = qty(l.delivered_qty) - qty(l.invoiced_qty)
    return {
      id: l.id as string,
      lineNo: Number(l.line_no),
      productId: l.product_id as string,
      variantId: (l.variant_id as string) ?? null,
      description: l.description as string,
      isStock: !!l.is_stock,
      taxRate: num(l.tax_rate, PCT_SCALE)!,
      taxExemptionReason: (l.tax_exemption_reason as string) ?? null,
      basePrice: num(l.base_price, PRICE_SCALE),
      netUnitPrice: num(l.net_unit_price, PRICE_SCALE)!,
      manualDiscountPct: num(l.manual_discount_pct, PCT_SCALE),
      manualUnitPrice: num(l.manual_unit_price, PRICE_SCALE),
      pricing: l.pricing as Record<string, unknown>,
      invoiceable: qtyText(pending > 0n ? pending : 0n),
    }
  })
  return { order: o, lines }
}

/**
 * Regista quantidades facturadas na emissão da factura (na mesma transacção): bloqueia as linhas, recusa facturar
 * mais do que o entregue e ainda não facturado (nunca duplica), actualiza o estado de facturação e fecha a encomenda
 * quando está toda entregue e facturada.
 */
export async function recordInvoiced(
  scope: TenantScope,
  orderId: string,
  lines: { orderLineId: string; quantity: string }[],
  invoiceRef: string
) {
  const o = await load(scope, orderId, true)
  if (!['CONFIRMED', 'CLOSED'].includes(o.status))
    throw ApiError.conflict('INVALID_STATE', 'A encomenda já não pode ser facturada.')
  const rows = await lineRows(scope, orderId, true)
  const per = new Map<string, bigint>()
  const issues: ErrorDetail[] = []
  lines.forEach((x, i) => {
    const l = rows.find((r) => r.id === x.orderLineId)
    if (!l)
      return issues.push({
        path: `lines.${i}.orderLineId`,
        code: 'NOT_FOUND',
        message: 'Linha inexistente nesta encomenda.',
      })
    const total = (per.get(l.id) ?? 0n) + qty(x.quantity)
    const can = qty(l.delivered_qty) - qty(l.invoiced_qty)
    if (total > can)
      issues.push({
        path: `lines.${i}.quantity`,
        code: 'OVER_INVOICED',
        message: `Da linha ${l.line_no} só há ${qtyText(can > 0n ? can : 0n)} entregue por facturar.`,
      })
    per.set(l.id, total)
  })
  if (issues.length) throw new ApiError(409, 'OVER_INVOICED', issues[0].message, issues)
  for (const [lineId, quantity] of per) {
    const l = rows.find((r) => r.id === lineId)!
    await scope.trx.rawQuery(
      `update sales_order_lines set invoiced_qty = invoiced_qty + ?, version = version + 1, updated_at = now(), updated_by = ?
        where tenant_id = ? and id = ?`,
      [qtyText(quantity), scope.context.userId, scope.context.tenantId, l.id]
    )
  }
  await refreshStatuses(scope, orderId)
  const after = await load(scope, orderId)
  if (
    after.status === 'CONFIRMED' &&
    after.delivery_status === 'FULL' &&
    after.invoicing_status === 'FULL'
  )
    await setOrder(scope, orderId, { status: 'CLOSED' })
  await event(scope, orderId, 'INVOICED', null, {
    invoice: invoiceRef,
    lines: [...per].map(([l, q]) => ({ lineId: l, quantity: qtyText(q) })),
  })
}
