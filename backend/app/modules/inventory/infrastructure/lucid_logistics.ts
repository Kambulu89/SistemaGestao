import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import { costText, fromDb, qtyText, roundDiv } from '#modules/inventory/domain/decimal'
import type {
  CountStatus,
  ReturnCondition,
  ReturnDirection,
  ReturnStatus,
  TransferStatus,
} from '#modules/inventory/domain/logistics'
import type {
  Count,
  CountFilter,
  CountLine,
  CountStore,
  GoodsReturn,
  ReturnFilter,
  ReturnLine,
  ReturnStore,
  SourceLine,
  Transfer,
  TransferFilter,
  TransferLine,
  TransferReceipt,
  TransferStore,
} from '#modules/inventory/application/logistics_ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

async function versioned(
  rows: { rows: unknown[] },
  current: () => Promise<{ version: number } | null>
): Promise<void> {
  if (rows.rows.length > 0) return
  const row = await current()
  if (!row) throw ApiError.notFound()
  throw ApiError.versionConflict(row.version)
}

// --- transferências ----------------------------------------------------------------------------------

interface TransferRow {
  id: string
  organization_id: string
  number: string | null
  source_warehouse_id: string
  destination_warehouse_id: string
  status: TransferStatus
  notes: string | null
  dispatched_at: Date | null
  cancelled_at: Date | null
  cancel_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const TRANSFER_COLUMNS = `id, organization_id, number, source_warehouse_id, destination_warehouse_id, status, notes,
  dispatched_at, cancelled_at, cancel_reason, version, created_at, updated_at`
const toTransfer = (r: TransferRow): Transfer => ({
  id: r.id,
  organizationId: r.organization_id,
  number: r.number,
  sourceWarehouseId: r.source_warehouse_id,
  destinationWarehouseId: r.destination_warehouse_id,
  status: r.status,
  notes: r.notes,
  dispatchedAt: r.dispatched_at,
  cancelledAt: r.cancelled_at,
  cancelReason: r.cancel_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface TransferLineRow {
  id: string
  transfer_id: string
  position: number
  variant_id: string
  lot_id: string | null
  source_location_id: string
  destination_location_id: string
  quantity: string
  dispatched_qty: string
  received_qty: string
  version: number
  created_at: Date
  updated_at: Date
}
const TRANSFER_LINE_COLUMNS = `id, transfer_id, position, variant_id, lot_id, source_location_id,
  destination_location_id, quantity, dispatched_qty, received_qty, version, created_at, updated_at`
const toTransferLine = (r: TransferLineRow): TransferLine => ({
  id: r.id,
  transferId: r.transfer_id,
  position: r.position,
  variantId: r.variant_id,
  lotId: r.lot_id,
  sourceLocationId: r.source_location_id,
  destinationLocationId: r.destination_location_id,
  quantity: r.quantity,
  dispatchedQty: r.dispatched_qty,
  receivedQty: r.received_qty,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidTransferStore implements TransferStore {
  async list(scope: TenantScope, filter: TransferFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.warehouseId) {
      where.push('(source_warehouse_id = ? or destination_warehouse_id = ?)')
      params.push(filter.warehouseId, filter.warehouseId)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${TRANSFER_COLUMNS} from stock_transfers where ${clause}
        order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from stock_transfers where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as TransferRow[]).map(toTransfer),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${TRANSFER_COLUMNS} from stock_transfers where tenant_id = ? and id = ? ${lock ? 'for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as TransferRow[]
    return row ? toTransfer(row) : null
  }

  async insert(
    scope: TenantScope,
    v: {
      organizationId: string
      sourceWarehouseId: string
      destinationWarehouseId: string
      notes: string | null
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into stock_transfers (tenant_id, organization_id, source_warehouse_id, destination_warehouse_id, notes,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.sourceWarehouseId,
        v.destinationWarehouseId,
        v.notes,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Transfer
  }

  async updateNotes(scope: TenantScope, id: string, expectedVersion: number, notes: string | null) {
    const result = await trxOf(scope).rawQuery(
      `update stock_transfers set notes = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [notes, actorOf(scope), tenantOf(scope), id, expectedVersion] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return (await this.find(scope, id)) as Transfer
  }

  async setStatus(
    scope: TenantScope,
    id: string,
    patch:
      | { status: 'DISPATCHED'; number: string }
      | { status: 'PARTIAL_RECEIVED' | 'RECEIVED' }
      | { status: 'CANCELLED'; reason: string }
  ) {
    await trxOf(scope).rawQuery(
      `update stock_transfers
          set status = ?,
              number = case when ? = 'DISPATCHED' then ? else number end,
              dispatched_at = case when ? = 'DISPATCHED' then now() else dispatched_at end,
              cancelled_at = case when ? = 'CANCELLED' then now() else cancelled_at end,
              cancel_reason = case when ? = 'CANCELLED' then ? else cancel_reason end,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [
        patch.status,
        patch.status,
        'number' in patch ? patch.number : null,
        patch.status,
        patch.status,
        patch.status,
        'reason' in patch ? patch.reason : null,
        actorOf(scope),
        tenantOf(scope),
        id,
      ] as never[]
    )
    return (await this.find(scope, id)) as Transfer
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `delete from transfer_lines where tenant_id = ? and transfer_id = ?`,
      [tenantOf(scope), id]
    )
    await trxOf(scope).rawQuery(`delete from stock_transfers where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async lines(scope: TenantScope, transferId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${TRANSFER_LINE_COLUMNS} from transfer_lines where tenant_id = ? and transfer_id = ? order by position`,
      [tenantOf(scope), transferId]
    )
    return (result.rows as TransferLineRow[]).map(toTransferLine)
  }

  async insertLine(
    scope: TenantScope,
    transferId: string,
    v: {
      variantId: string
      lotId: string | null
      sourceLocationId: string
      destinationLocationId: string
      quantity: string
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into transfer_lines (tenant_id, transfer_id, position, variant_id, lot_id, source_location_id,
         destination_location_id, quantity, created_by_membership_id, updated_by_membership_id)
       values (?, ?, (select coalesce(max(position), 0) + 1 from transfer_lines where tenant_id = ? and transfer_id = ?),
               ?, ?, ?, ?, ?, ?, ?) returning ${TRANSFER_LINE_COLUMNS}`,
      [
        tenantOf(scope),
        transferId,
        tenantOf(scope),
        transferId,
        v.variantId,
        v.lotId,
        v.sourceLocationId,
        v.destinationLocationId,
        v.quantity,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return toTransferLine(result.rows[0] as TransferLineRow)
  }

  async removeLine(scope: TenantScope, transferId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `delete from transfer_lines where tenant_id = ? and transfer_id = ? and id = ? returning id`,
      [tenantOf(scope), transferId, lineId]
    )
    return result.rows.length > 0
  }

  async markDispatched(scope: TenantScope, lineId: string, quantity: string) {
    await trxOf(scope).rawQuery(
      `update transfer_lines set dispatched_qty = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?`,
      [quantity, tenantOf(scope), lineId] as never[]
    )
  }

  async addReceived(scope: TenantScope, lineId: string, quantity: string) {
    await trxOf(scope).rawQuery(
      `update transfer_lines set received_qty = received_qty + ?::numeric, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?`,
      [quantity, tenantOf(scope), lineId] as never[]
    )
  }

  async receipts(scope: TenantScope, transferId: string) {
    const result = await trxOf(scope).rawQuery(
      `select r.id, r.transfer_id, r.idempotency_key, r.received_at, l.transfer_line_id, l.quantity
         from transfer_receipts r
         left join transfer_receipt_lines l on l.tenant_id = r.tenant_id and l.receipt_id = r.id
        where r.tenant_id = ? and r.transfer_id = ?
        order by r.received_at, r.id, l.transfer_line_id`,
      [tenantOf(scope), transferId]
    )
    const map = new Map<string, TransferReceipt>()
    for (const row of result.rows as {
      id: string
      transfer_id: string
      idempotency_key: string | null
      received_at: Date
      transfer_line_id: string | null
      quantity: string | null
    }[]) {
      let receipt = map.get(row.id)
      if (!receipt) {
        receipt = {
          id: row.id,
          transferId: row.transfer_id,
          idempotencyKey: row.idempotency_key,
          receivedAt: row.received_at,
          lines: [],
        }
        map.set(row.id, receipt)
      }
      if (row.transfer_line_id && row.quantity) {
        receipt.lines.push({ transferLineId: row.transfer_line_id, quantity: row.quantity })
      }
    }
    return [...map.values()]
  }

  async findReceiptByKey(scope: TenantScope, transferId: string, key: string) {
    const all = await this.receipts(scope, transferId)
    return all.find((r) => r.idempotencyKey === key) ?? null
  }

  async insertReceipt(
    scope: TenantScope,
    transferId: string,
    key: string | null,
    lines: { transferLineId: string; quantity: string }[]
  ) {
    const created = await trxOf(scope).rawQuery(
      `insert into transfer_receipts (tenant_id, transfer_id, idempotency_key, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, ?, ?, ?) returning id, received_at`,
      [tenantOf(scope), transferId, key, actorOf(scope), actorOf(scope)] as never[]
    )
    const row = created.rows[0] as { id: string; received_at: Date }
    const id = row.id
    for (const line of lines) {
      await trxOf(scope).rawQuery(
        `insert into transfer_receipt_lines (tenant_id, receipt_id, transfer_line_id, quantity,
           created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?)`,
        [
          tenantOf(scope),
          id,
          line.transferLineId,
          line.quantity,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
    }
    return {
      id,
      transferId,
      idempotencyKey: key,
      receivedAt: row.received_at,
      lines,
    } as TransferReceipt
  }
}

// --- contagens ---------------------------------------------------------------------------------------

interface CountRow {
  id: string
  organization_id: string
  warehouse_id: string
  number: string | null
  status: CountStatus
  freeze_mode: 'LOCATION'
  blind: boolean
  location_ids: string[]
  snapshot_at: Date | null
  posted_at: Date | null
  notes: string | null
  cancel_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const COUNT_COLUMNS = `id, organization_id, warehouse_id, number, status, freeze_mode, blind, location_ids, snapshot_at,
  posted_at, notes, cancel_reason, version, created_at, updated_at`
const toCount = (r: CountRow): Count => ({
  id: r.id,
  organizationId: r.organization_id,
  warehouseId: r.warehouse_id,
  number: r.number,
  status: r.status,
  freezeMode: r.freeze_mode,
  blind: r.blind,
  locationIds: r.location_ids,
  snapshotAt: r.snapshot_at,
  postedAt: r.posted_at,
  notes: r.notes,
  cancelReason: r.cancel_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface CountLineRow {
  id: string
  count_id: string
  variant_id: string
  location_id: string
  lot_id: string | null
  expected_qty: string
  counted_qty: string | null
  variance_qty: string | null
  reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const COUNT_LINE_COLUMNS = `id, count_id, variant_id, location_id, lot_id, expected_qty, counted_qty, variance_qty,
  reason, version, created_at, updated_at`
const toCountLine = (r: CountLineRow): CountLine => ({
  id: r.id,
  countId: r.count_id,
  variantId: r.variant_id,
  locationId: r.location_id,
  lotId: r.lot_id,
  expectedQty: r.expected_qty,
  countedQty: r.counted_qty,
  varianceQty: r.variance_qty,
  reason: r.reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidCountStore implements CountStore {
  async list(scope: TenantScope, filter: CountFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['status', filter.status],
      ['warehouse_id', filter.warehouseId],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${COUNT_COLUMNS} from stock_counts where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from stock_counts where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as CountRow[]).map(toCount),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${COUNT_COLUMNS} from stock_counts where tenant_id = ? and id = ? ${lock ? 'for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as CountRow[]
    return row ? toCount(row) : null
  }

  async insert(
    scope: TenantScope,
    v: {
      organizationId: string
      warehouseId: string
      blind: boolean
      locationIds: string[]
      notes: string | null
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into stock_counts (tenant_id, organization_id, warehouse_id, blind, location_ids, notes,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?::jsonb, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.warehouseId,
        v.blind,
        JSON.stringify(v.locationIds),
        v.notes,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Count
  }

  async setStatus(
    scope: TenantScope,
    id: string,
    patch:
      | { status: 'OPEN'; number: string }
      | { status: 'REVIEW' }
      | { status: 'POSTED' }
      | { status: 'CANCELLED'; reason: string }
      | { status: 'OPEN' }
  ) {
    await trxOf(scope).rawQuery(
      `update stock_counts
          set status = ?,
              number = case when ? = 'OPEN' and ?::text is not null then ?::text else number end,
              snapshot_at = case when ? = 'OPEN' and ?::text is not null then now() else snapshot_at end,
              posted_at = case when ? = 'POSTED' then now() else posted_at end,
              cancel_reason = case when ? = 'CANCELLED' then ? else cancel_reason end,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [
        patch.status,
        patch.status,
        'number' in patch ? patch.number : null,
        'number' in patch ? patch.number : null,
        patch.status,
        'number' in patch ? patch.number : null,
        patch.status,
        patch.status,
        'reason' in patch ? patch.reason : null,
        actorOf(scope),
        tenantOf(scope),
        id,
      ] as never[]
    )
    return (await this.find(scope, id)) as Count
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from stock_counts where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async freeze(scope: TenantScope, countId: string, locationIds: string[]) {
    if (locationIds.length === 0) return []
    // Bloqueia os locais por ordem de id: duas contagens a abrir ao mesmo tempo nunca se cruzam.
    const locked = await trxOf(scope).rawQuery(
      `select id, frozen_by_count_id from stock_locations
        where tenant_id = ? and id = any(?::uuid[]) order by id for update`,
      [tenantOf(scope), locationIds] as never[]
    )
    const taken = (locked.rows as { id: string; frozen_by_count_id: string | null }[])
      .filter((l) => l.frozen_by_count_id !== null && l.frozen_by_count_id !== countId)
      .map((l) => l.id)
    if (taken.length > 0) return taken
    await trxOf(scope).rawQuery(
      `update stock_locations set frozen_by_count_id = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = any(?::uuid[])`,
      [countId, tenantOf(scope), locationIds] as never[]
    )
    return []
  }

  async unfreeze(scope: TenantScope, countId: string) {
    await trxOf(scope).rawQuery(
      `update stock_locations set frozen_by_count_id = null, updated_at = now(), version = version + 1
        where tenant_id = ? and frozen_by_count_id = ?`,
      [tenantOf(scope), countId] as never[]
    )
  }

  async snapshotBalances(scope: TenantScope, locationIds: string[]) {
    if (locationIds.length === 0) return []
    const result = await trxOf(scope).rawQuery(
      `select variant_id, location_id, lot_id, on_hand from stock_balances
        where tenant_id = ? and location_id = any(?::uuid[]) and on_hand <> 0
        order by location_id, variant_id, id
          for update`,
      [tenantOf(scope), locationIds] as never[]
    )
    return (
      result.rows as {
        variant_id: string
        location_id: string
        lot_id: string | null
        on_hand: string
      }[]
    ).map((r) => ({
      variantId: r.variant_id,
      locationId: r.location_id,
      lotId: r.lot_id,
      onHand: r.on_hand,
    }))
  }

  async lines(scope: TenantScope, countId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${COUNT_LINE_COLUMNS} from count_lines where tenant_id = ? and count_id = ?
        order by location_id, variant_id, id`,
      [tenantOf(scope), countId]
    )
    return (result.rows as CountLineRow[]).map(toCountLine)
  }

  async findLine(scope: TenantScope, countId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${COUNT_LINE_COLUMNS} from count_lines where tenant_id = ? and count_id = ? and id = ?`,
      [tenantOf(scope), countId, lineId]
    )
    const [row] = result.rows as CountLineRow[]
    return row ? toCountLine(row) : null
  }

  async insertLine(
    scope: TenantScope,
    countId: string,
    v: { variantId: string; locationId: string; lotId: string | null; expectedQty: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into count_lines (tenant_id, count_id, variant_id, location_id, lot_id, expected_qty,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning ${COUNT_LINE_COLUMNS}`,
      [
        tenantOf(scope),
        countId,
        v.variantId,
        v.locationId,
        v.lotId,
        v.expectedQty,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    const [row] = result.rows as CountLineRow[]
    return row ? toCountLine(row) : null
  }

  async setCounted(scope: TenantScope, lineId: string, countedQty: string, reason: string | null) {
    await trxOf(scope).rawQuery(
      `update count_lines set counted_qty = ?, reason = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ?`,
      [countedQty, reason, actorOf(scope), tenantOf(scope), lineId] as never[]
    )
  }
}

// --- devoluções --------------------------------------------------------------------------------------

interface ReturnRow {
  id: string
  organization_id: string
  number: string | null
  direction: ReturnDirection
  source_document_id: string
  warehouse_id: string
  reason: string
  status: ReturnStatus
  approved_at: Date | null
  posted_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}
const RETURN_COLUMNS = `id, organization_id, number, direction, source_document_id, warehouse_id, reason, status,
  approved_at, posted_at, version, created_at, updated_at`
const toReturn = (r: ReturnRow): GoodsReturn => ({
  id: r.id,
  organizationId: r.organization_id,
  number: r.number,
  direction: r.direction,
  sourceDocumentId: r.source_document_id,
  warehouseId: r.warehouse_id,
  reason: r.reason,
  status: r.status,
  approvedAt: r.approved_at,
  postedAt: r.posted_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface ReturnLineRow {
  id: string
  return_id: string
  position: number
  source_line_id: string
  variant_id: string
  lot_id: string | null
  location_id: string | null
  quantity: string
  condition: ReturnCondition
  version: number
  created_at: Date
  updated_at: Date
}
const RETURN_LINE_COLUMNS = `id, return_id, position, source_line_id, variant_id, lot_id, location_id, quantity,
  condition, version, created_at, updated_at`
const toReturnLine = (r: ReturnLineRow): ReturnLine => ({
  id: r.id,
  returnId: r.return_id,
  position: r.position,
  sourceLineId: r.source_line_id,
  variantId: r.variant_id,
  lotId: r.lot_id,
  locationId: r.location_id,
  quantity: r.quantity,
  condition: r.condition,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidReturnStore implements ReturnStore {
  async list(scope: TenantScope, filter: ReturnFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['direction', filter.direction],
      ['status', filter.status],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${RETURN_COLUMNS} from goods_returns where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from goods_returns where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as ReturnRow[]).map(toReturn),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${RETURN_COLUMNS} from goods_returns where tenant_id = ? and id = ? ${lock ? 'for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as ReturnRow[]
    return row ? toReturn(row) : null
  }

  async insert(
    scope: TenantScope,
    v: {
      organizationId: string
      direction: ReturnDirection
      sourceDocumentId: string
      warehouseId: string
      reason: string
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into goods_returns (tenant_id, organization_id, direction, source_document_id, warehouse_id, reason,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.direction,
        v.sourceDocumentId,
        v.warehouseId,
        v.reason,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as GoodsReturn
  }

  async setStatus(
    scope: TenantScope,
    id: string,
    patch: { status: 'APPROVED' } | { status: 'POSTED'; number: string }
  ) {
    await trxOf(scope).rawQuery(
      `update goods_returns
          set status = ?,
              approved_at = case when ? = 'APPROVED' then now() else approved_at end,
              number = case when ? = 'POSTED' then ?::text else number end,
              posted_at = case when ? = 'POSTED' then now() else posted_at end,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [
        patch.status,
        patch.status,
        patch.status,
        'number' in patch ? patch.number : null,
        patch.status,
        actorOf(scope),
        tenantOf(scope),
        id,
      ] as never[]
    )
    return (await this.find(scope, id)) as GoodsReturn
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from return_lines where tenant_id = ? and return_id = ?`, [
      tenantOf(scope),
      id,
    ])
    await trxOf(scope).rawQuery(`delete from goods_returns where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async lines(scope: TenantScope, returnId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${RETURN_LINE_COLUMNS} from return_lines where tenant_id = ? and return_id = ? order by position`,
      [tenantOf(scope), returnId]
    )
    return (result.rows as ReturnLineRow[]).map(toReturnLine)
  }

  async insertLine(
    scope: TenantScope,
    returnId: string,
    v: {
      sourceLineId: string
      variantId: string
      lotId: string | null
      locationId: string | null
      quantity: string
      condition: ReturnCondition
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into return_lines (tenant_id, return_id, position, source_line_id, variant_id, lot_id, location_id,
         quantity, condition, created_by_membership_id, updated_by_membership_id)
       values (?, ?, (select coalesce(max(position), 0) + 1 from return_lines where tenant_id = ? and return_id = ?),
               ?, ?, ?, ?, ?, ?, ?, ?) returning ${RETURN_LINE_COLUMNS}`,
      [
        tenantOf(scope),
        returnId,
        tenantOf(scope),
        returnId,
        v.sourceLineId,
        v.variantId,
        v.lotId,
        v.locationId,
        v.quantity,
        v.condition,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return toReturnLine(result.rows[0] as ReturnLineRow)
  }

  async removeLine(scope: TenantScope, returnId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `delete from return_lines where tenant_id = ? and return_id = ? and id = ? returning id`,
      [tenantOf(scope), returnId, lineId]
    )
    return result.rows.length > 0
  }

  async sourceLines(
    scope: TenantScope,
    sourceType: 'SHIPMENT' | 'GOODS_RECEIPT',
    sourceDocumentId: string
  ): Promise<SourceLine[]> {
    const kind = sourceType === 'SHIPMENT' ? 'ISSUE' : 'RECEIPT'
    const result = await trxOf(scope).rawQuery(
      `select m.source_line_id, m.variant_id, m.lot_id, m.organization_id, abs(m.quantity_delta) as quantity,
              m.unit_cost
         from stock_movements m
        where m.tenant_id = ? and m.source_type = ? and m.source_id = ? and m.movement_kind = ?
          and m.source_line_id is not null
          and not exists (select 1 from stock_movements r
                           where r.tenant_id = m.tenant_id and r.reversed_movement_id = m.id)
        order by m.posted_at, m.id`,
      [tenantOf(scope), sourceType, sourceDocumentId, kind]
    )
    // Uma linha pode ter vários movimentos (vários lotes ou locais): junta por linha e lote, com custo ponderado.
    const grouped = new Map<string, { row: SourceLine; qty: bigint; value: bigint }>()
    for (const r of result.rows as {
      source_line_id: string
      variant_id: string
      lot_id: string | null
      organization_id: string
      quantity: string
      unit_cost: string
    }[]) {
      const key = `${r.source_line_id}:${r.lot_id ?? ''}`
      const qty = fromDb(r.quantity, 6)
      const cost = fromDb(r.unit_cost, 4)
      const entry = grouped.get(key)
      if (entry) {
        entry.qty += qty
        entry.value += qty * cost
      } else {
        grouped.set(key, {
          row: {
            sourceLineId: r.source_line_id,
            variantId: r.variant_id,
            lotId: r.lot_id,
            organizationId: r.organization_id,
            quantity: '',
            unitCost: '',
          },
          qty,
          value: qty * cost,
        })
      }
    }
    return [...grouped.values()].map(({ row, qty, value }) => ({
      ...row,
      quantity: qtyText(qty),
      // custo = Σ(qtd·custo) / Σqtd; as 6 casas da quantidade cancelam-se.
      unitCost: costText(qty === 0n ? 0n : roundDiv(value, qty)),
    }))
  }

  async returnedBySourceLine(
    scope: TenantScope,
    sourceDocumentId: string,
    exceptReturnId?: string
  ) {
    const result = await trxOf(scope).rawQuery(
      `select l.source_line_id, sum(l.quantity)::numeric(19,6) as quantity
         from return_lines l
         join goods_returns r on r.tenant_id = l.tenant_id and r.id = l.return_id
        where l.tenant_id = ? and r.source_document_id = ? and r.status in ('APPROVED', 'POSTED')
          and (?::uuid is null or r.id <> ?::uuid)
        group by l.source_line_id`,
      [tenantOf(scope), sourceDocumentId, exceptReturnId ?? null, exceptReturnId ?? null] as never[]
    )
    const map = new Map<string, string>()
    for (const row of result.rows as { source_line_id: string; quantity: string }[]) {
      map.set(row.source_line_id, row.quantity)
    }
    return map
  }

  async lockSource(scope: TenantScope, sourceDocumentId: string) {
    await trxOf(scope).rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
      `${tenantOf(scope)}:return-source:${sourceDocumentId}`,
    ])
  }
}
