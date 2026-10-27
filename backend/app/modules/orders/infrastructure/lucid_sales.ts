import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type { Totals } from '#modules/orders/domain/money'
import type {
  OrderHeaderValues,
  OrderStatus,
  QuoteHeaderValues,
  QuoteStatus,
} from '#modules/orders/domain/sales'
import type {
  DocumentFilter,
  Line,
  LineStore,
  LineValues,
  Order,
  OrderStore,
  Owner,
  PriceOrigin,
  Quote,
  QuoteStore,
} from '#modules/orders/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null)

// --- propostas --------------------------------------------------------------------------------------

interface QuoteRow {
  id: string
  organization_id: string
  customer_id: string
  number: string | null
  valid_until: string
  currency: string
  status: QuoteStatus
  notes: string | null
  net_total: string
  tax_total: string
  total: string
  version: number
  created_at: Date
  updated_at: Date
}
const QUOTE_COLUMNS = `id, organization_id, customer_id, number, valid_until::text as valid_until, currency, status, notes,
  net_total::text as net_total, tax_total::text as tax_total, total::text as total, version, created_at, updated_at`
const toQuote = (r: QuoteRow): Quote => ({
  id: r.id,
  organizationId: r.organization_id,
  customerId: r.customer_id,
  number: r.number,
  validUntil: r.valid_until,
  currency: r.currency,
  status: r.status,
  notes: r.notes,
  totals: { net: r.net_total, tax: r.tax_total, total: r.total },
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

/** `status=EXPIRED` é derivado: enviada e já fora da validade; `SENT` exclui as expiradas. */
function quoteStatusClause(status: string | undefined, today: string): [string, unknown[]] | null {
  if (!status) return null
  if (status === 'EXPIRED') return ["status = 'SENT' and valid_until < ?", [today]]
  if (status === 'SENT') return ["status = 'SENT' and valid_until >= ?", [today]]
  return ['status = ?', [status]]
}

export class LucidQuoteStore implements QuoteStore {
  async list(scope: TenantScope, filter: DocumentFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.customerId) {
      where.push('customer_id = ?')
      params.push(filter.customerId)
    }
    if (filter.organizationId) {
      where.push('organization_id = ?')
      params.push(filter.organizationId)
    }
    if (filter.q) {
      where.push(`lower(coalesce(number, '')) like ?`)
      params.push(`%${escapeLike(filter.q.toLowerCase())}%`)
    }
    const status = quoteStatusClause(filter.status, filter.today)
    if (status) {
      where.push(status[0])
      params.push(...status[1])
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${QUOTE_COLUMNS} from sales_quotes where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from sales_quotes where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as QuoteRow[]).map(toQuote),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${QUOTE_COLUMNS} from sales_quotes where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as QuoteRow[]
    return row ? toQuote(row) : null
  }

  async insert(scope: TenantScope, v: QuoteHeaderValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into sales_quotes (tenant_id, organization_id, customer_id, valid_until, currency, notes,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.customerId,
        v.validUntil,
        v.currency,
        v.notes,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Quote
  }

  async updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: QuoteHeaderValues
  ) {
    const result = await trxOf(scope).rawQuery(
      `update sales_quotes
          set valid_until = ?, currency = ?, notes = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.validUntil,
        v.currency,
        v.notes,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }

  async setTotals(scope: TenantScope, id: string, t: Totals) {
    await trxOf(scope).rawQuery(
      `update sales_quotes
          set net_total = ?, tax_total = ?, total = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [t.net, t.tax, t.total, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return (await this.find(scope, id)) as Quote
  }

  async transition(scope: TenantScope, id: string, to: { status: QuoteStatus; number?: string }) {
    await trxOf(scope).rawQuery(
      `update sales_quotes
          set status = ?, number = coalesce(?, number), updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [to.status, to.number ?? null, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return (await this.find(scope, id)) as Quote
  }
}

// --- encomendas -------------------------------------------------------------------------------------

interface OrderRow {
  id: string
  organization_id: string
  customer_id: string
  quote_id: string | null
  number: string | null
  order_date: string
  currency: string
  status: OrderStatus
  delivery_address_snapshot: Record<string, string> | null
  credit_reservation: string
  net_total: string
  tax_total: string
  total: string
  confirmed_at: Date | null
  cancelled_at: Date | null
  cancel_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const ORDER_COLUMNS = `id, organization_id, customer_id, quote_id, number, order_date::text as order_date, currency, status,
  delivery_address_snapshot, credit_reservation::text as credit_reservation, net_total::text as net_total,
  tax_total::text as tax_total, total::text as total, confirmed_at, cancelled_at, cancel_reason, version, created_at, updated_at`
const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  organizationId: r.organization_id,
  customerId: r.customer_id,
  quoteId: r.quote_id,
  number: r.number,
  orderDate: r.order_date,
  currency: r.currency,
  status: r.status,
  deliveryAddress: r.delivery_address_snapshot,
  creditReservation: r.credit_reservation,
  totals: { net: r.net_total, tax: r.tax_total, total: r.total },
  confirmedAt: iso(r.confirmed_at),
  cancelledAt: iso(r.cancelled_at),
  cancelReason: r.cancel_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidOrderStore implements OrderStore {
  async list(scope: TenantScope, filter: DocumentFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.customerId) {
      where.push('customer_id = ?')
      params.push(filter.customerId)
    }
    if (filter.organizationId) {
      where.push('organization_id = ?')
      params.push(filter.organizationId)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.q) {
      where.push(`lower(coalesce(number, '')) like ?`)
      params.push(`%${escapeLike(filter.q.toLowerCase())}%`)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${ORDER_COLUMNS} from sales_orders where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from sales_orders where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as OrderRow[]).map(toOrder),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${ORDER_COLUMNS} from sales_orders where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as OrderRow[]
    return row ? toOrder(row) : null
  }

  async findByQuote(scope: TenantScope, quoteId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${ORDER_COLUMNS} from sales_orders where tenant_id = ? and quote_id = ?`,
      [tenantOf(scope), quoteId]
    )
    const [row] = result.rows as OrderRow[]
    return row ? toOrder(row) : null
  }

  async insert(scope: TenantScope, v: OrderHeaderValues, quoteId: string | null) {
    const result = await trxOf(scope).rawQuery(
      `insert into sales_orders (tenant_id, organization_id, customer_id, quote_id, order_date, currency,
         delivery_address_snapshot, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.customerId,
        quoteId,
        v.orderDate,
        v.currency,
        v.deliveryAddress ? JSON.stringify(v.deliveryAddress) : null,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Order
  }

  async updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: OrderHeaderValues
  ) {
    const result = await trxOf(scope).rawQuery(
      `update sales_orders
          set order_date = ?, currency = ?, delivery_address_snapshot = ?::jsonb,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.orderDate,
        v.currency,
        v.deliveryAddress ? JSON.stringify(v.deliveryAddress) : null,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }

  async setTotals(scope: TenantScope, id: string, t: Totals) {
    await trxOf(scope).rawQuery(
      `update sales_orders
          set net_total = ?, tax_total = ?, total = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [t.net, t.tax, t.total, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return (await this.find(scope, id)) as Order
  }

  async confirm(scope: TenantScope, id: string, number: string) {
    await trxOf(scope).rawQuery(
      `update sales_orders
          set status = 'CONFIRMED', number = ?, confirmed_at = now(), updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [number, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return (await this.find(scope, id)) as Order
  }

  async cancel(scope: TenantScope, id: string, reason: string) {
    await trxOf(scope).rawQuery(
      `update sales_orders
          set status = 'CANCELLED', cancelled_at = now(), cancel_reason = ?, credit_reservation = 0,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [reason, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return (await this.find(scope, id)) as Order
  }
}

// --- linhas -----------------------------------------------------------------------------------------

interface LineRow {
  id: string
  position: number
  variant_id: string
  description_snapshot: string
  quantity: string
  unit_id: string
  unit_price: string
  discount_rate: string
  tax_rate_snapshot: string
  tax_inclusive: boolean
  net_amount: string
  tax_amount: string
  total: string
  price_origin: PriceOrigin
  version: number
  created_at: Date
  updated_at: Date
}
const LINE_COLUMNS = `id, position, variant_id, description_snapshot, quantity::text as quantity, unit_id,
  unit_price::text as unit_price, discount_rate::text as discount_rate, tax_rate_snapshot::text as tax_rate_snapshot,
  tax_inclusive, net_amount::text as net_amount, tax_amount::text as tax_amount, total::text as total,
  price_origin, version, created_at, updated_at`
const toLine = (r: LineRow): Line => ({
  id: r.id,
  position: r.position,
  variantId: r.variant_id,
  descriptionSnapshot: r.description_snapshot,
  quantity: r.quantity,
  unitId: r.unit_id,
  unitPrice: r.unit_price,
  discountRate: r.discount_rate,
  taxRateSnapshot: r.tax_rate_snapshot,
  taxInclusive: r.tax_inclusive,
  netAmount: r.net_amount,
  taxAmount: r.tax_amount,
  total: r.total,
  priceOrigin: r.price_origin,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const ownerClause = (owner: Owner): [string, string] =>
  'quoteId' in owner ? ['quote_id = ?', owner.quoteId] : ['order_id = ?', owner.orderId]

export class LucidLineStore implements LineStore {
  async list(scope: TenantScope, owner: Owner) {
    const [clause, id] = ownerClause(owner)
    const result = await trxOf(scope).rawQuery(
      `select ${LINE_COLUMNS} from sales_lines where tenant_id = ? and ${clause} order by position`,
      [tenantOf(scope), id]
    )
    return (result.rows as LineRow[]).map(toLine)
  }

  async find(scope: TenantScope, owner: Owner, id: string) {
    const [clause, ownerId] = ownerClause(owner)
    const result = await trxOf(scope).rawQuery(
      `select ${LINE_COLUMNS} from sales_lines where tenant_id = ? and ${clause} and id = ?`,
      [tenantOf(scope), ownerId, id]
    )
    const [row] = result.rows as LineRow[]
    return row ? toLine(row) : null
  }

  async insert(scope: TenantScope, owner: Owner, v: LineValues) {
    const [clause, ownerId] = ownerClause(owner)
    const column = clause.split(' ')[0] as string
    const result = await trxOf(scope).rawQuery(
      `insert into sales_lines (tenant_id, ${column}, position, variant_id, description_snapshot, quantity, unit_id,
         unit_price, discount_rate, tax_rate_snapshot, tax_inclusive, net_amount, tax_amount, total, price_origin,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, (select coalesce(max(position), 0) + 1 from sales_lines where tenant_id = ? and ${clause}),
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
       returning id`,
      [
        tenantOf(scope),
        ownerId,
        tenantOf(scope),
        ownerId,
        v.variantId,
        v.descriptionSnapshot,
        v.quantity,
        v.unitId,
        v.unitPrice,
        v.discountRate,
        v.taxRateSnapshot,
        v.taxInclusive,
        v.netAmount,
        v.taxAmount,
        v.total,
        JSON.stringify(v.priceOrigin),
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, owner, (result.rows[0] as { id: string }).id)) as Line
  }

  async update(scope: TenantScope, id: string, v: LineValues) {
    const result = await trxOf(scope).rawQuery(
      `update sales_lines
          set description_snapshot = ?, quantity = ?, unit_id = ?, unit_price = ?, discount_rate = ?,
              tax_rate_snapshot = ?, tax_inclusive = ?, net_amount = ?, tax_amount = ?, total = ?, price_origin = ?::jsonb,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?
        returning ${LINE_COLUMNS}`,
      [
        v.descriptionSnapshot,
        v.quantity,
        v.unitId,
        v.unitPrice,
        v.discountRate,
        v.taxRateSnapshot,
        v.taxInclusive,
        v.netAmount,
        v.taxAmount,
        v.total,
        JSON.stringify(v.priceOrigin),
        actorOf(scope),
        tenantOf(scope),
        id,
      ] as never[]
    )
    return toLine((result.rows as LineRow[])[0] as LineRow)
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery('delete from sales_lines where tenant_id = ? and id = ?', [
      tenantOf(scope),
      id,
    ])
  }
}
