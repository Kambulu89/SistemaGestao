import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type { ShipmentStatus } from '#modules/orders/domain/shipments'
import type {
  Shipment,
  ShipmentFilter,
  ShipmentLine,
  ShipmentStore,
} from '#modules/orders/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

interface ShipmentRow {
  id: string
  organization_id: string
  order_id: string
  number: string | null
  status: ShipmentStatus
  notes: string | null
  shipped_at: Date | null
  reversed_at: Date | null
  reverse_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const SHIPMENT_COLUMNS = `id, organization_id, order_id, number, status, notes, shipped_at, reversed_at, reverse_reason,
  version, created_at, updated_at`
const toShipment = (r: ShipmentRow): Shipment => ({
  id: r.id,
  organizationId: r.organization_id,
  orderId: r.order_id,
  number: r.number,
  status: r.status,
  notes: r.notes,
  shippedAt: r.shipped_at,
  reversedAt: r.reversed_at,
  reverseReason: r.reverse_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface LineRow {
  id: string
  shipment_id: string
  order_line_id: string
  quantity: string
  version: number
  created_at: Date
  updated_at: Date
}
const LINE_COLUMNS = 'id, shipment_id, order_line_id, quantity, version, created_at, updated_at'
const toLine = (r: LineRow): ShipmentLine => ({
  id: r.id,
  shipmentId: r.shipment_id,
  orderLineId: r.order_line_id,
  quantity: r.quantity,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidShipmentStore implements ShipmentStore {
  async list(scope: TenantScope, filter: ShipmentFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.orderId) {
      where.push('order_id = ?')
      params.push(filter.orderId)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${SHIPMENT_COLUMNS} from shipments where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from shipments where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as ShipmentRow[]).map(toShipment),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${SHIPMENT_COLUMNS} from shipments where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as ShipmentRow[]
    return row ? toShipment(row) : null
  }

  async insert(
    scope: TenantScope,
    v: { organizationId: string; orderId: string; notes: string | null }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into shipments (tenant_id, organization_id, order_id, notes, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) returning ${SHIPMENT_COLUMNS}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.orderId,
        v.notes as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toShipment((result.rows as ShipmentRow[])[0] as ShipmentRow)
  }

  async updateNotes(scope: TenantScope, id: string, expectedVersion: number, notes: string | null) {
    const result = await trxOf(scope).rawQuery(
      `update shipments set notes = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [notes as never, actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `delete from shipment_lines where tenant_id = ? and shipment_id = ?`,
      [tenantOf(scope), id]
    )
    await trxOf(scope).rawQuery(`delete from shipments where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async post(scope: TenantScope, id: string, number: string) {
    await trxOf(scope).rawQuery(
      `update shipments set status = 'POSTED', number = ?, shipped_at = now(), updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [number, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Shipment
  }

  async reverse(scope: TenantScope, id: string, reason: string) {
    await trxOf(scope).rawQuery(
      `update shipments set status = 'REVERSED', reversed_at = now(), reverse_reason = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [reason, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Shipment
  }

  async listLines(scope: TenantScope, shipmentId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${LINE_COLUMNS} from shipment_lines where tenant_id = ? and shipment_id = ? order by created_at, id`,
      [tenantOf(scope), shipmentId]
    )
    return (result.rows as LineRow[]).map(toLine)
  }

  async findLine(scope: TenantScope, shipmentId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${LINE_COLUMNS} from shipment_lines where tenant_id = ? and shipment_id = ? and id = ?`,
      [tenantOf(scope), shipmentId, lineId]
    )
    const [row] = result.rows as LineRow[]
    return row ? toLine(row) : null
  }

  async insertLine(
    scope: TenantScope,
    shipmentId: string,
    v: { orderLineId: string; quantity: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into shipment_lines (tenant_id, shipment_id, order_line_id, quantity, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) on conflict do nothing returning ${LINE_COLUMNS}`,
      [tenantOf(scope), shipmentId, v.orderLineId, v.quantity, actorOf(scope), actorOf(scope)]
    )
    const [row] = result.rows as LineRow[]
    return row ? toLine(row) : null
  }

  async updateLine(scope: TenantScope, id: string, quantity: string) {
    const result = await trxOf(scope).rawQuery(
      `update shipment_lines set quantity = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? returning ${LINE_COLUMNS}`,
      [quantity, actorOf(scope), tenantOf(scope), id]
    )
    return toLine((result.rows as LineRow[])[0] as LineRow)
  }

  async removeLine(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from shipment_lines where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async shippedByLine(scope: TenantScope, orderId: string) {
    const result = await trxOf(scope).rawQuery(
      `select l.order_line_id, sum(l.quantity) as shipped
         from shipment_lines l
         join shipments s on s.tenant_id = l.tenant_id and s.id = l.shipment_id
        where l.tenant_id = ? and s.order_id = ? and s.status = 'POSTED'
        group by l.order_line_id`,
      [tenantOf(scope), orderId]
    )
    return new Map(
      (result.rows as { order_line_id: string; shipped: string }[]).map((r) => [
        r.order_line_id,
        r.shipped,
      ])
    )
  }
}
