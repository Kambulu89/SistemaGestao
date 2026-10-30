import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import { costText, fromDb, qtyText } from '#modules/inventory/domain/decimal'
import type { ReservationStatus } from '#modules/inventory/domain/stock'
import type {
  BalanceFilter,
  BalanceKey,
  BalanceRow,
  BalanceView,
  Candidate,
  CostState,
  LedgerStore,
  Location,
  LocationRef,
  Lot,
  LotStore,
  Movement,
  MovementFilter,
  MovementValues,
  Reservation,
  ReservationFilter,
  ReservationStore,
  ReservationValues,
  Warehouse,
  WarehouseStore,
} from '#modules/inventory/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const uniqueViolation = (error: unknown): string | null =>
  (error as { code?: string }).code === '23505'
    ? ((error as { constraint?: string }).constraint ?? '')
    : null

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

// --- armazéns e locais ------------------------------------------------------------------------------

interface WarehouseRow {
  id: string
  organization_id: string
  code: string
  name: string
  allow_negative: boolean
  allow_backorder: boolean
  sales_default: boolean
  technical: boolean
  active: boolean
  version: number
  created_at: Date
  updated_at: Date
}
const WAREHOUSE_COLUMNS = `id, organization_id, code, name, allow_negative, allow_backorder, sales_default, technical, active,
  version, created_at, updated_at`
const toWarehouse = (r: WarehouseRow): Warehouse => ({
  id: r.id,
  organizationId: r.organization_id,
  code: r.code,
  name: r.name,
  allowNegative: r.allow_negative,
  allowBackorder: r.allow_backorder,
  salesDefault: r.sales_default,
  technical: r.technical,
  active: r.active,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface LocationRow {
  id: string
  warehouse_id: string
  code: string
  name: string
  active: boolean
  frozen_by_count_id: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const LOCATION_COLUMNS =
  'id, warehouse_id, code, name, active, frozen_by_count_id, version, created_at, updated_at'
const toLocation = (r: LocationRow): Location => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  code: r.code,
  name: r.name,
  active: r.active,
  frozenByCountId: r.frozen_by_count_id,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidWarehouseStore implements WarehouseStore {
  async list(scope: TenantScope, filter: { organizationId?: string }) {
    const params: unknown[] = [tenantOf(scope)]
    let where = 'tenant_id = ?'
    if (filter.organizationId) {
      where += ' and organization_id = ?'
      params.push(filter.organizationId)
    }
    const result = await trxOf(scope).rawQuery(
      `select ${WAREHOUSE_COLUMNS} from warehouses where ${where} order by code`,
      params as never[]
    )
    return (result.rows as WarehouseRow[]).map(toWarehouse)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${WAREHOUSE_COLUMNS} from warehouses where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as WarehouseRow[]
    return row ? toWarehouse(row) : null
  }

  async insert(
    scope: TenantScope,
    v: Pick<Warehouse, 'organizationId' | 'code' | 'name'> &
      Partial<Pick<Warehouse, 'allowNegative' | 'allowBackorder'>>
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into warehouses (tenant_id, organization_id, code, name, allow_negative, allow_backorder,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.code,
        v.name,
        v.allowNegative ?? false,
        v.allowBackorder ?? false,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<Warehouse, 'name' | 'allowNegative' | 'allowBackorder' | 'salesDefault' | 'active'>
    >
  ) {
    const columns: Record<string, string> = {
      name: 'name',
      allowNegative: 'allow_negative',
      allowBackorder: 'allow_backorder',
      salesDefault: 'sales_default',
      active: 'active',
    }
    const sets: string[] = []
    const params: unknown[] = []
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key]
      if (value !== undefined) {
        sets.push(`${column} = ?`)
        params.push(value)
      }
    }
    let rows: unknown[]
    try {
      const result = await trxOf(scope).rawQuery(
        `update warehouses
            set ${sets.join(', ')}${sets.length ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
          where tenant_id = ? and id = ? and version = ? returning id`,
        [...params, actorOf(scope), tenantOf(scope), id, expectedVersion] as never[]
      )
      rows = result.rows
    } catch (error) {
      if (uniqueViolation(error) === 'warehouses_sales_default_unique') return 'SALES_DEFAULT_TAKEN'
      throw error
    }
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }

  async findSalesDefault(scope: TenantScope, organizationId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${WAREHOUSE_COLUMNS} from warehouses
        where tenant_id = ? and organization_id = ? and sales_default and active`,
      [tenantOf(scope), organizationId]
    )
    const [row] = result.rows as WarehouseRow[]
    return row ? toWarehouse(row) : null
  }

  async listLocations(scope: TenantScope, warehouseId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${LOCATION_COLUMNS} from stock_locations where tenant_id = ? and warehouse_id = ? order by code`,
      [tenantOf(scope), warehouseId]
    )
    return (result.rows as LocationRow[]).map(toLocation)
  }

  async findLocation(scope: TenantScope, id: string): Promise<LocationRef | null> {
    const result = await trxOf(scope).rawQuery(
      `select l.id, l.warehouse_id, w.organization_id, l.active, w.active as warehouse_active, w.allow_negative,
              l.frozen_by_count_id
         from stock_locations l
         join warehouses w on w.tenant_id = l.tenant_id and w.id = l.warehouse_id
        where l.tenant_id = ? and l.id = ?
          for share of l`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as {
      id: string
      warehouse_id: string
      organization_id: string
      active: boolean
      warehouse_active: boolean
      allow_negative: boolean
      frozen_by_count_id: string | null
    }[]
    return row
      ? {
          id: row.id,
          warehouseId: row.warehouse_id,
          organizationId: row.organization_id,
          active: row.active,
          warehouseActive: row.warehouse_active,
          allowNegative: row.allow_negative,
          frozenByCountId: row.frozen_by_count_id,
        }
      : null
  }

  async ensureTechnical(
    scope: TenantScope,
    organizationId: string,
    warehouse: { code: string; name: string },
    location: { code: string; name: string }
  ) {
    await trxOf(scope).rawQuery(
      `insert into warehouses (tenant_id, organization_id, code, name, technical, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, ?, ?, true, ?, ?) on conflict do nothing`,
      [
        tenantOf(scope),
        organizationId,
        warehouse.code,
        warehouse.name,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const found = await trxOf(scope).rawQuery(
      `select id from warehouses where tenant_id = ? and organization_id = ? and code = ?`,
      [tenantOf(scope), organizationId, warehouse.code]
    )
    const warehouseId = (found.rows[0] as { id: string }).id
    await trxOf(scope).rawQuery(
      `insert into stock_locations (tenant_id, warehouse_id, code, name, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) on conflict do nothing`,
      [tenantOf(scope), warehouseId, location.code, location.name, actorOf(scope), actorOf(scope)]
    )
    const place = await trxOf(scope).rawQuery(
      `select id from stock_locations where tenant_id = ? and warehouse_id = ? and code = ?`,
      [tenantOf(scope), warehouseId, location.code]
    )
    return { warehouseId, locationId: (place.rows[0] as { id: string }).id }
  }

  async findLocationRow(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${LOCATION_COLUMNS} from stock_locations where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as LocationRow[]
    return row ? toLocation(row) : null
  }

  async insertLocation(scope: TenantScope, warehouseId: string, v: { code: string; name: string }) {
    const result = await trxOf(scope).rawQuery(
      `insert into stock_locations (tenant_id, warehouse_id, code, name, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [tenantOf(scope), warehouseId, v.code, v.name, actorOf(scope), actorOf(scope)]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.findLocationRow(scope, created.id) : null
  }

  async updateLocation(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<Location, 'name' | 'active'>>
  ) {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.active !== undefined) {
      sets.push('active = ?')
      params.push(patch.active)
    }
    const result = await trxOf(scope).rawQuery(
      `update stock_locations
          set ${sets.join(', ')}${sets.length ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [...params, actorOf(scope), tenantOf(scope), id, expectedVersion] as never[]
    )
    const row = await this.findLocationRow(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }
}

// --- lotes ------------------------------------------------------------------------------------------

interface LotRow {
  id: string
  variant_id: string
  code: string
  manufactured_on: string | null
  expires_on: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const LOT_COLUMNS = `id, variant_id, code, manufactured_on::text as manufactured_on, expires_on::text as expires_on,
  version, created_at, updated_at`
const toLot = (r: LotRow): Lot => ({
  id: r.id,
  variantId: r.variant_id,
  code: r.code,
  manufacturedOn: r.manufactured_on,
  expiresOn: r.expires_on,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidLotStore implements LotStore {
  async list(scope: TenantScope, filter: { variantId?: string }) {
    const params: unknown[] = [tenantOf(scope)]
    let where = 'tenant_id = ?'
    if (filter.variantId) {
      where += ' and variant_id = ?'
      params.push(filter.variantId)
    }
    const result = await trxOf(scope).rawQuery(
      `select ${LOT_COLUMNS} from lots where ${where} order by expires_on nulls last, code`,
      params as never[]
    )
    return (result.rows as LotRow[]).map(toLot)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${LOT_COLUMNS} from lots where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as LotRow[]
    return row ? toLot(row) : null
  }

  async insert(
    scope: TenantScope,
    v: Pick<Lot, 'variantId' | 'code' | 'manufacturedOn' | 'expiresOn'>
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into lots (tenant_id, variant_id, code, manufactured_on, expires_on, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [
        tenantOf(scope),
        v.variantId,
        v.code,
        v.manufacturedOn as never,
        v.expiresOn as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }
}

// --- livro, saldos e custos -------------------------------------------------------------------------

interface BalanceDbRow {
  id: string
  variant_id: string
  location_id: string
  lot_id: string | null
  on_hand: string
  reserved: string
  version: number
}
const toBalanceRow = (r: BalanceDbRow): BalanceRow => ({
  id: r.id,
  variantId: r.variant_id,
  locationId: r.location_id,
  lotId: r.lot_id,
  onHand: r.on_hand,
  reserved: r.reserved,
  version: r.version,
})

interface MovementDbRow {
  id: string
  organization_id: string
  variant_id: string
  location_id: string
  lot_id: string | null
  quantity_delta: string
  unit_cost: string
  source_type: string
  source_id: string
  source_line_id: string | null
  effect: string
  movement_kind: Movement['kind']
  reversed_movement_id: string | null
  reason: string | null
  posted_at: Date
}
const MOVEMENT_COLUMNS = `id, organization_id, variant_id, location_id, lot_id, quantity_delta, unit_cost, source_type,
  source_id, source_line_id, effect, movement_kind, reversed_movement_id, reason, posted_at`
const toMovement = (r: MovementDbRow): Movement => ({
  id: r.id,
  organizationId: r.organization_id,
  variantId: r.variant_id,
  locationId: r.location_id,
  lotId: r.lot_id,
  quantityDelta: r.quantity_delta,
  unitCost: r.unit_cost,
  sourceType: r.source_type,
  sourceId: r.source_id,
  sourceLineId: r.source_line_id,
  effect: r.effect,
  kind: r.movement_kind,
  reversedMovementId: r.reversed_movement_id,
  reason: r.reason,
  postedAt: r.posted_at,
})

export class LucidLedgerStore implements LedgerStore {
  async lockBalance(scope: TenantScope, key: BalanceKey) {
    const trx = trxOf(scope)
    // Cria a linha se faltar (concorrência: só uma cria) e bloqueia-a; a chave trata o lote nulo como dimensão.
    await trx.rawQuery(
      `insert into stock_balances (tenant_id, variant_id, location_id, lot_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, variant_id, location_id, (coalesce(lot_id, '${ZERO_UUID}'::uuid))) do nothing`,
      [
        tenantOf(scope),
        key.variantId,
        key.locationId,
        key.lotId as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const result = await trx.rawQuery(
      `select id, variant_id, location_id, lot_id, on_hand, reserved, version from stock_balances
        where tenant_id = ? and variant_id = ? and location_id = ?
          and coalesce(lot_id, '${ZERO_UUID}'::uuid) = coalesce(?::uuid, '${ZERO_UUID}'::uuid)
        for update`,
      [tenantOf(scope), key.variantId, key.locationId, key.lotId as never]
    )
    return toBalanceRow((result.rows as BalanceDbRow[])[0] as BalanceDbRow)
  }

  async saveBalance(scope: TenantScope, id: string, onHand: string, reserved: string) {
    await trxOf(scope).rawQuery(
      `update stock_balances set on_hand = ?, reserved = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ?`,
      [onHand, reserved, actorOf(scope), tenantOf(scope), id]
    )
  }

  async lockCandidates(scope: TenantScope, variantId: string, warehouseId: string) {
    const result = await trxOf(scope).rawQuery(
      `select b.id, b.variant_id, b.location_id, b.lot_id, b.on_hand, b.reserved, b.version,
              l.expires_on::text as expires_on
         from stock_balances b
         join stock_locations s on s.tenant_id = b.tenant_id and s.id = b.location_id
         left join lots l on l.tenant_id = b.tenant_id and l.id = b.lot_id
        where b.tenant_id = ? and b.variant_id = ? and s.warehouse_id = ? and s.active
        order by l.expires_on nulls last, l.code nulls first, s.code, b.id
        for update of b`,
      [tenantOf(scope), variantId, warehouseId]
    )
    return (result.rows as (BalanceDbRow & { expires_on: string | null })[]).map(
      (r): Candidate => ({ ...toBalanceRow(r), expiresOn: r.expires_on })
    )
  }

  async listBalances(scope: TenantScope, filter: BalanceFilter) {
    const where = ['b.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.variantId) {
      where.push('b.variant_id = ?')
      params.push(filter.variantId)
    }
    if (filter.locationId) {
      where.push('b.location_id = ?')
      params.push(filter.locationId)
    }
    if (filter.warehouseId) {
      where.push('s.warehouse_id = ?')
      params.push(filter.warehouseId)
    }
    if (filter.lotId) {
      where.push('b.lot_id = ?')
      params.push(filter.lotId)
    }
    if (filter.nonZero) where.push('(b.on_hand <> 0 or b.reserved <> 0)')
    const clause = where.join(' and ')
    const from = `from stock_balances b
         join stock_locations s on s.tenant_id = b.tenant_id and s.id = b.location_id
         left join lots l on l.tenant_id = b.tenant_id and l.id = b.lot_id`
    const rows = await trxOf(scope).rawQuery(
      `select b.id, b.variant_id, b.location_id, b.lot_id, b.on_hand, b.reserved, b.version,
              s.warehouse_id, l.code as lot_code, l.expires_on::text as expires_on
         ${from} where ${clause} order by b.variant_id, s.code, l.code nulls first, b.id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total ${from} where ${clause}`,
      params as never[]
    )
    const items = (
      rows.rows as (BalanceDbRow & {
        warehouse_id: string
        lot_code: string | null
        expires_on: string | null
      })[]
    ).map((r): BalanceView => ({
      ...toBalanceRow(r),
      warehouseId: r.warehouse_id,
      available: qtyText(fromDb(r.on_hand, 6) - fromDb(r.reserved, 6)),
      lotCode: r.lot_code,
      expiresOn: r.expires_on,
    }))
    return { items, total: (count.rows[0] as { total: number }).total }
  }

  async findBySource(
    scope: TenantScope,
    source: { type: string; id: string; lineId: string | null; effect: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `select ${MOVEMENT_COLUMNS} from stock_movements
        where tenant_id = ? and source_type = ? and source_id = ?
          and coalesce(source_line_id, '${ZERO_UUID}'::uuid) = coalesce(?::uuid, '${ZERO_UUID}'::uuid)
          and effect = ?`,
      [tenantOf(scope), source.type, source.id, source.lineId as never, source.effect]
    )
    const [row] = result.rows as MovementDbRow[]
    return row ? toMovement(row) : null
  }

  async findMovement(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${MOVEMENT_COLUMNS} from stock_movements where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as MovementDbRow[]
    return row ? toMovement(row) : null
  }

  async movementsBySource(scope: TenantScope, type: string, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${MOVEMENT_COLUMNS} from stock_movements
        where tenant_id = ? and source_type = ? and source_id = ? order by posted_at, id`,
      [tenantOf(scope), type, id]
    )
    return (result.rows as MovementDbRow[]).map(toMovement)
  }

  async insertMovement(scope: TenantScope, v: MovementValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into stock_movements (tenant_id, organization_id, variant_id, location_id, lot_id, quantity_delta, unit_cost,
         source_type, source_id, source_line_id, effect, movement_kind, reversed_movement_id, reason,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${MOVEMENT_COLUMNS}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.variantId,
        v.locationId,
        v.lotId as never,
        v.quantityDelta,
        v.unitCost,
        v.sourceType,
        v.sourceId,
        v.sourceLineId as never,
        v.effect,
        v.kind,
        v.reversedMovementId as never,
        v.reason as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toMovement((result.rows as MovementDbRow[])[0] as MovementDbRow)
  }

  async listMovements(scope: TenantScope, filter: MovementFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['variant_id', filter.variantId],
      ['location_id', filter.locationId],
      ['source_type', filter.sourceType],
      ['source_id', filter.sourceId],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${MOVEMENT_COLUMNS} from stock_movements where ${clause}
        order by posted_at desc, id desc limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from stock_movements where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as MovementDbRow[]).map(toMovement),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async lockCost(scope: TenantScope, warehouseId: string, variantId: string): Promise<CostState> {
    const trx = trxOf(scope)
    await trx.rawQuery(
      `insert into stock_costs (tenant_id, warehouse_id, variant_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?) on conflict (tenant_id, warehouse_id, variant_id) do nothing`,
      [tenantOf(scope), warehouseId, variantId, actorOf(scope), actorOf(scope)]
    )
    const result = await trx.rawQuery(
      `select quantity, avg_cost from stock_costs where tenant_id = ? and warehouse_id = ? and variant_id = ? for update`,
      [tenantOf(scope), warehouseId, variantId]
    )
    const [row] = result.rows as { quantity: string; avg_cost: string }[]
    return { quantity: fromDb(row!.quantity, 6), avgCost: fromDb(row!.avg_cost, 4) }
  }

  async saveCost(scope: TenantScope, warehouseId: string, variantId: string, state: CostState) {
    await trxOf(scope).rawQuery(
      `update stock_costs set quantity = ?, avg_cost = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and warehouse_id = ? and variant_id = ?`,
      [
        qtyText(state.quantity),
        costText(state.avgCost),
        actorOf(scope),
        tenantOf(scope),
        warehouseId,
        variantId,
      ]
    )
  }

  async ledgerSum(scope: TenantScope, key: BalanceKey) {
    const result = await trxOf(scope).rawQuery(
      `select coalesce(sum(quantity_delta), 0) as total from stock_movements
        where tenant_id = ? and variant_id = ? and location_id = ?
          and coalesce(lot_id, '${ZERO_UUID}'::uuid) = coalesce(?::uuid, '${ZERO_UUID}'::uuid)`,
      [tenantOf(scope), key.variantId, key.locationId, key.lotId as never]
    )
    return (result.rows[0] as { total: string }).total
  }

  async hasMovements(scope: TenantScope, variantIds: readonly string[]) {
    if (variantIds.length === 0) return false
    const result = await trxOf(scope).rawQuery(
      `select 1 from stock_movements where tenant_id = ? and variant_id = any(?::uuid[]) limit 1`,
      [tenantOf(scope), variantIds as never]
    )
    return result.rows.length > 0
  }
}

// --- reservas ---------------------------------------------------------------------------------------

interface ReservationRow {
  id: string
  organization_id: string
  variant_id: string
  location_id: string
  lot_id: string | null
  source_type: string
  source_id: string
  source_line_id: string | null
  quantity: string
  consumed_qty: string
  released_qty: string
  expires_at: Date | null
  status: ReservationStatus
  version: number
  created_at: Date
  updated_at: Date
}
const RESERVATION_COLUMNS = `id, organization_id, variant_id, location_id, lot_id, source_type, source_id, source_line_id,
  quantity, consumed_qty, released_qty, expires_at, status, version, created_at, updated_at`
const toReservation = (r: ReservationRow): Reservation => ({
  id: r.id,
  organizationId: r.organization_id,
  variantId: r.variant_id,
  locationId: r.location_id,
  lotId: r.lot_id,
  sourceType: r.source_type,
  sourceId: r.source_id,
  sourceLineId: r.source_line_id,
  quantity: r.quantity,
  consumedQty: r.consumed_qty,
  releasedQty: r.released_qty,
  expiresAt: r.expires_at,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidReservationStore implements ReservationStore {
  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${RESERVATION_COLUMNS} from stock_reservations where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as ReservationRow[]
    return row ? toReservation(row) : null
  }

  async findByKey(
    scope: TenantScope,
    v: Pick<ReservationValues, 'sourceType' | 'sourceId' | 'sourceLineId' | 'locationId' | 'lotId'>
  ) {
    const result = await trxOf(scope).rawQuery(
      `select ${RESERVATION_COLUMNS} from stock_reservations
        where tenant_id = ? and source_type = ? and source_id = ? and location_id = ?
          and coalesce(source_line_id, '${ZERO_UUID}'::uuid) = coalesce(?::uuid, '${ZERO_UUID}'::uuid)
          and coalesce(lot_id, '${ZERO_UUID}'::uuid) = coalesce(?::uuid, '${ZERO_UUID}'::uuid)`,
      [
        tenantOf(scope),
        v.sourceType,
        v.sourceId,
        v.locationId,
        v.sourceLineId as never,
        v.lotId as never,
      ]
    )
    const [row] = result.rows as ReservationRow[]
    return row ? toReservation(row) : null
  }

  async insert(scope: TenantScope, v: ReservationValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into stock_reservations (tenant_id, organization_id, variant_id, location_id, lot_id, source_type, source_id,
         source_line_id, quantity, expires_at, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${RESERVATION_COLUMNS}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.variantId,
        v.locationId,
        v.lotId as never,
        v.sourceType,
        v.sourceId,
        v.sourceLineId as never,
        v.quantity,
        v.expiresAt as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toReservation((result.rows as ReservationRow[])[0] as ReservationRow)
  }

  async lockActiveBySource(scope: TenantScope, sourceType: string, sourceId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${RESERVATION_COLUMNS} from stock_reservations
        where tenant_id = ? and source_type = ? and source_id = ? and status = 'ACTIVE'
        order by variant_id, location_id, coalesce(lot_id, '${ZERO_UUID}'::uuid), id for update`,
      [tenantOf(scope), sourceType, sourceId]
    )
    return (result.rows as ReservationRow[]).map(toReservation)
  }

  async lockActiveBySourceLine(
    scope: TenantScope,
    sourceType: string,
    sourceId: string,
    sourceLineId: string
  ) {
    const result = await trxOf(scope).rawQuery(
      `select ${RESERVATION_COLUMNS} from stock_reservations
        where tenant_id = ? and source_type = ? and source_id = ? and source_line_id = ? and status = 'ACTIVE'
        order by variant_id, location_id, coalesce(lot_id, '${ZERO_UUID}'::uuid), id for update`,
      [tenantOf(scope), sourceType, sourceId, sourceLineId]
    )
    return (result.rows as ReservationRow[]).map(toReservation)
  }

  async update(
    scope: TenantScope,
    id: string,
    parts: { consumedQty: string; releasedQty: string; status: ReservationStatus }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update stock_reservations set consumed_qty = ?, released_qty = ?, status = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? returning ${RESERVATION_COLUMNS}`,
      [parts.consumedQty, parts.releasedQty, parts.status, actorOf(scope), tenantOf(scope), id]
    )
    return toReservation((result.rows as ReservationRow[])[0] as ReservationRow)
  }

  async list(scope: TenantScope, filter: ReservationFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['variant_id', filter.variantId],
      ['source_type', filter.sourceType],
      ['source_id', filter.sourceId],
      ['status', filter.status],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${RESERVATION_COLUMNS} from stock_reservations where ${clause}
        order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from stock_reservations where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as ReservationRow[]).map(toReservation),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async lockExpired(scope: TenantScope, now: Date, limit: number) {
    const result = await trxOf(scope).rawQuery(
      `select ${RESERVATION_COLUMNS} from stock_reservations
        where tenant_id = ? and status = 'ACTIVE' and expires_at is not null and expires_at <= ?
        order by variant_id, location_id, coalesce(lot_id, '${ZERO_UUID}'::uuid), id
        limit ? for update`,
      [tenantOf(scope), now, limit] as never[]
    )
    return (result.rows as ReservationRow[]).map(toReservation)
  }
}
