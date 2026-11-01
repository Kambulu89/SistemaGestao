import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { MovementKind, ReservationStatus } from '#modules/inventory/domain/stock'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface Warehouse extends Audited {
  organizationId: string
  code: string
  name: string
  allowNegative: boolean
  allowBackorder: boolean
  salesDefault: boolean
  /** Armazém técnico (trânsito, danificado, quarentena): nunca é o armazém de vendas. */
  technical: boolean
  active: boolean
}

export interface Location extends Audited {
  warehouseId: string
  code: string
  name: string
  active: boolean
  /** A contagem que congela o local, se houver. */
  frozenByCountId: string | null
}

/** O local com o que o armazém dele impõe (organização, saldo negativo, estado). */
export interface LocationRef {
  id: string
  warehouseId: string
  organizationId: string
  active: boolean
  warehouseActive: boolean
  allowNegative: boolean
  frozenByCountId: string | null
}

export interface Lot extends Audited {
  variantId: string
  code: string
  manufacturedOn: string | null
  expiresOn: string | null
}

/** Linha do saldo tal como está na base de dados (decimais em texto). */
export interface BalanceRow {
  id: string
  variantId: string
  locationId: string
  lotId: string | null
  onHand: string
  reserved: string
  version: number
}

export interface BalanceView extends BalanceRow {
  warehouseId: string
  /** `onHand − reserved`. */
  available: string
  lotCode: string | null
  expiresOn: string | null
}

export interface Movement {
  id: string
  organizationId: string
  variantId: string
  locationId: string
  lotId: string | null
  quantityDelta: string
  unitCost: string
  sourceType: string
  sourceId: string
  sourceLineId: string | null
  effect: string
  kind: MovementKind
  reversedMovementId: string | null
  reason: string | null
  postedAt: Date
}

export interface MovementValues {
  organizationId: string
  variantId: string
  locationId: string
  lotId: string | null
  quantityDelta: string
  unitCost: string
  sourceType: string
  sourceId: string
  sourceLineId: string | null
  effect: string
  kind: MovementKind
  reversedMovementId: string | null
  reason: string | null
}

export interface Reservation extends Audited {
  organizationId: string
  variantId: string
  locationId: string
  lotId: string | null
  sourceType: string
  sourceId: string
  sourceLineId: string | null
  quantity: string
  consumedQty: string
  releasedQty: string
  expiresAt: Date | null
  status: ReservationStatus
}

export interface ReservationValues {
  organizationId: string
  variantId: string
  locationId: string
  lotId: string | null
  sourceType: string
  sourceId: string
  sourceLineId: string | null
  quantity: string
  expiresAt: Date | null
}

export interface BalanceKey {
  variantId: string
  locationId: string
  lotId: string | null
}

export interface CostState {
  quantity: bigint
  avgCost: bigint
}

/** Uma linha candidata a alocar: saldo bloqueado com a validade do lote. */
export interface Candidate extends BalanceRow {
  expiresOn: string | null
}

export interface BalanceFilter {
  variantId?: string
  warehouseId?: string
  locationId?: string
  lotId?: string
  nonZero?: boolean
  limit: number
  offset: number
}

export interface MovementFilter {
  variantId?: string
  locationId?: string
  sourceType?: string
  sourceId?: string
  limit: number
  offset: number
}

export interface ReservationFilter {
  variantId?: string
  sourceType?: string
  sourceId?: string
  status?: ReservationStatus
  limit: number
  offset: number
}

export interface WarehouseStore {
  list(scope: TenantScope, filter: { organizationId?: string }): Promise<Warehouse[]>
  find(scope: TenantScope, id: string): Promise<Warehouse | null>
  /** `null` se o código já existir na organização. */
  insert(
    scope: TenantScope,
    values: Pick<Warehouse, 'organizationId' | 'code' | 'name'> &
      Partial<Pick<Warehouse, 'allowNegative' | 'allowBackorder'>>
  ): Promise<Warehouse | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<Warehouse, 'name' | 'allowNegative' | 'allowBackorder' | 'salesDefault' | 'active'>
    >
  ): Promise<Warehouse | 'SALES_DEFAULT_TAKEN'>
  /** O armazém «de vendas» da organização, se houver. */
  findSalesDefault(scope: TenantScope, organizationId: string): Promise<Warehouse | null>
  listLocations(scope: TenantScope, warehouseId: string): Promise<Location[]>
  findLocation(scope: TenantScope, id: string): Promise<LocationRef | null>
  findLocationRow(scope: TenantScope, id: string): Promise<Location | null>
  /** Garante o armazém técnico da organização e o seu local (criados à primeira necessidade, sem duplicar). */
  ensureTechnical(
    scope: TenantScope,
    organizationId: string,
    warehouse: { code: string; name: string },
    location: { code: string; name: string }
  ): Promise<{ warehouseId: string; locationId: string }>
  /** `null` se o código já existir no armazém. */
  insertLocation(
    scope: TenantScope,
    warehouseId: string,
    values: { code: string; name: string }
  ): Promise<Location | null>
  updateLocation(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<Location, 'name' | 'active'>>
  ): Promise<Location>
}

export interface LotStore {
  list(scope: TenantScope, filter: { variantId?: string }): Promise<Lot[]>
  find(scope: TenantScope, id: string): Promise<Lot | null>
  /** `null` se o código já existir para a variante. */
  insert(
    scope: TenantScope,
    values: Pick<Lot, 'variantId' | 'code' | 'manufacturedOn' | 'expiresOn'>
  ): Promise<Lot | null>
}

export interface LedgerStore {
  /** Cria (se não existir) e bloqueia o saldo da chave. */
  lockBalance(scope: TenantScope, key: BalanceKey): Promise<BalanceRow>
  saveBalance(scope: TenantScope, id: string, onHand: string, reserved: string): Promise<void>
  /** Saldos da variante no armazém, bloqueados, por validade (FEFO), depois lote, local e id. */
  lockCandidates(scope: TenantScope, variantId: string, warehouseId: string): Promise<Candidate[]>
  /** Saldo das localizações do armazém que a reserva indicou (para libertar sob bloqueio determinístico). */
  listBalances(
    scope: TenantScope,
    filter: BalanceFilter
  ): Promise<{ items: BalanceView[]; total: number }>
  findBySource(
    scope: TenantScope,
    source: { type: string; id: string; lineId: string | null; effect: string }
  ): Promise<Movement | null>
  findMovement(scope: TenantScope, id: string): Promise<Movement | null>
  /** Todos os movimentos de uma origem (p. ex. as baixas de uma expedição), por ordem de lançamento. */
  movementsBySource(scope: TenantScope, type: string, id: string): Promise<Movement[]>
  insertMovement(scope: TenantScope, values: MovementValues): Promise<Movement>
  listMovements(
    scope: TenantScope,
    filter: MovementFilter
  ): Promise<{ items: Movement[]; total: number }>
  lockCost(scope: TenantScope, warehouseId: string, variantId: string): Promise<CostState>
  saveCost(
    scope: TenantScope,
    warehouseId: string,
    variantId: string,
    state: CostState
  ): Promise<void>
  /** Soma do livro por chave (reconciliação com o saldo). */
  ledgerSum(scope: TenantScope, key: BalanceKey): Promise<string>
  hasMovements(scope: TenantScope, variantIds: readonly string[]): Promise<boolean>
}

export interface ReservationStore {
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Reservation | null>
  findByKey(
    scope: TenantScope,
    values: Pick<
      ReservationValues,
      'sourceType' | 'sourceId' | 'sourceLineId' | 'locationId' | 'lotId'
    >
  ): Promise<Reservation | null>
  insert(scope: TenantScope, values: ReservationValues): Promise<Reservation>
  /** Reservas activas de uma origem, bloqueadas, por chave de saldo (ordem determinística). */
  lockActiveBySource(
    scope: TenantScope,
    sourceType: string,
    sourceId: string
  ): Promise<Reservation[]>
  /** Reservas activas de uma linha de uma origem, bloqueadas, por chave de saldo (ordem determinística). */
  lockActiveBySourceLine(
    scope: TenantScope,
    sourceType: string,
    sourceId: string,
    sourceLineId: string
  ): Promise<Reservation[]>
  update(
    scope: TenantScope,
    id: string,
    parts: { consumedQty: string; releasedQty: string; status: ReservationStatus }
  ): Promise<Reservation>
  list(
    scope: TenantScope,
    filter: ReservationFilter
  ): Promise<{ items: Reservation[]; total: number }>
  /** Reservas activas com `expires_at` ≤ `now`, bloqueadas. */
  lockExpired(scope: TenantScope, now: Date, limit: number): Promise<Reservation[]>
}

export interface VariantRef {
  id: string
  active: boolean
  product: {
    id: string
    baseUnitId: string
    trackStock: boolean
    trackingMode: 'NONE' | 'LOT' | 'SERIAL'
  }
}

/** Outros módulos, vistos pelas suas APIs públicas. */
export interface References {
  organizationExists(context: TenantContext, organizationId: string): Promise<boolean>
  variant(context: TenantContext, variantId: string): Promise<VariantRef | null>
  /** Casas decimais que a unidade admite (`null` se não existir). */
  unitPrecision(context: TenantContext, unitId: string): Promise<number | null>
  /** Emite o número do documento dentro da transacção (sem lacunas se a transacção anular). */
  issueNumber(
    scope: TenantScope,
    input: {
      organizationId: string
      documentType: 'STOCK_TRANSFER' | 'STOCK_COUNT' | 'GOODS_RETURN'
      date: Date
    }
  ): Promise<string>
}
