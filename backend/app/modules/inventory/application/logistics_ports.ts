import type { TenantScope } from '#core/tenancy/index'
import type {
  CountStatus,
  ReturnCondition,
  ReturnDirection,
  ReturnStatus,
  TransferStatus,
} from '#modules/inventory/domain/logistics'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

// --- transferências ----------------------------------------------------------------------------------

export interface Transfer extends Audited {
  organizationId: string
  number: string | null
  sourceWarehouseId: string
  destinationWarehouseId: string
  status: TransferStatus
  notes: string | null
  dispatchedAt: Date | null
  cancelledAt: Date | null
  cancelReason: string | null
}

export interface TransferLine extends Audited {
  transferId: string
  position: number
  variantId: string
  lotId: string | null
  sourceLocationId: string
  destinationLocationId: string
  quantity: string
  dispatchedQty: string
  receivedQty: string
}

export interface TransferReceipt {
  id: string
  transferId: string
  idempotencyKey: string | null
  receivedAt: Date
  lines: { transferLineId: string; quantity: string }[]
}

export interface TransferFilter {
  status?: TransferStatus
  warehouseId?: string
  limit: number
  offset: number
}

export interface TransferStore {
  list(scope: TenantScope, filter: TransferFilter): Promise<{ items: Transfer[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Transfer | null>
  insert(
    scope: TenantScope,
    values: {
      organizationId: string
      sourceWarehouseId: string
      destinationWarehouseId: string
      notes: string | null
    }
  ): Promise<Transfer>
  updateNotes(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    notes: string | null
  ): Promise<Transfer>
  setStatus(
    scope: TenantScope,
    id: string,
    patch:
      | { status: 'DISPATCHED'; number: string }
      | { status: 'PARTIAL_RECEIVED' | 'RECEIVED' }
      | { status: 'CANCELLED'; reason: string }
  ): Promise<Transfer>
  remove(scope: TenantScope, id: string): Promise<void>
  lines(scope: TenantScope, transferId: string): Promise<TransferLine[]>
  insertLine(
    scope: TenantScope,
    transferId: string,
    values: {
      variantId: string
      lotId: string | null
      sourceLocationId: string
      destinationLocationId: string
      quantity: string
    }
  ): Promise<TransferLine>
  removeLine(scope: TenantScope, transferId: string, lineId: string): Promise<boolean>
  markDispatched(scope: TenantScope, lineId: string, quantity: string): Promise<void>
  addReceived(scope: TenantScope, lineId: string, quantity: string): Promise<void>
  receipts(scope: TenantScope, transferId: string): Promise<TransferReceipt[]>
  findReceiptByKey(
    scope: TenantScope,
    transferId: string,
    key: string
  ): Promise<TransferReceipt | null>
  insertReceipt(
    scope: TenantScope,
    transferId: string,
    key: string | null,
    lines: { transferLineId: string; quantity: string }[]
  ): Promise<TransferReceipt>
}

// --- contagens ---------------------------------------------------------------------------------------

export interface Count extends Audited {
  organizationId: string
  warehouseId: string
  number: string | null
  status: CountStatus
  freezeMode: 'LOCATION'
  blind: boolean
  locationIds: string[]
  snapshotAt: Date | null
  postedAt: Date | null
  notes: string | null
  cancelReason: string | null
}

export interface CountLine extends Audited {
  countId: string
  variantId: string
  locationId: string
  lotId: string | null
  expectedQty: string
  countedQty: string | null
  varianceQty: string | null
  reason: string | null
}

export interface CountFilter {
  status?: CountStatus
  warehouseId?: string
  limit: number
  offset: number
}

export interface CountStore {
  list(scope: TenantScope, filter: CountFilter): Promise<{ items: Count[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Count | null>
  insert(
    scope: TenantScope,
    values: {
      organizationId: string
      warehouseId: string
      blind: boolean
      locationIds: string[]
      notes: string | null
    }
  ): Promise<Count>
  setStatus(
    scope: TenantScope,
    id: string,
    patch:
      | { status: 'OPEN'; number: string }
      | { status: 'REVIEW' }
      | { status: 'POSTED' }
      | { status: 'CANCELLED'; reason: string }
      | { status: 'OPEN' }
  ): Promise<Count>
  remove(scope: TenantScope, id: string): Promise<void>
  /** Congela os locais (devolve os que já estavam congelados por outra contagem). */
  freeze(scope: TenantScope, countId: string, locationIds: string[]): Promise<string[]>
  unfreeze(scope: TenantScope, countId: string): Promise<void>
  /** Bloqueia e devolve os saldos com stock nos locais (a fotografia do esperado). */
  snapshotBalances(
    scope: TenantScope,
    locationIds: string[]
  ): Promise<{ variantId: string; locationId: string; lotId: string | null; onHand: string }[]>
  lines(scope: TenantScope, countId: string): Promise<CountLine[]>
  findLine(scope: TenantScope, countId: string, lineId: string): Promise<CountLine | null>
  insertLine(
    scope: TenantScope,
    countId: string,
    values: {
      variantId: string
      locationId: string
      lotId: string | null
      expectedQty: string
    }
  ): Promise<CountLine | null>
  setCounted(
    scope: TenantScope,
    lineId: string,
    countedQty: string,
    reason: string | null
  ): Promise<void>
}

// --- devoluções --------------------------------------------------------------------------------------

export interface GoodsReturn extends Audited {
  organizationId: string
  number: string | null
  direction: ReturnDirection
  sourceDocumentId: string
  warehouseId: string
  reason: string
  status: ReturnStatus
  approvedAt: Date | null
  postedAt: Date | null
}

export interface ReturnLine extends Audited {
  returnId: string
  position: number
  sourceLineId: string
  variantId: string
  lotId: string | null
  locationId: string | null
  quantity: string
  condition: ReturnCondition
}

/** Uma linha do documento de origem tal como o livro a conhece (líquida das reversões). */
export interface SourceLine {
  sourceLineId: string
  variantId: string
  lotId: string | null
  organizationId: string
  quantity: string
  /** Custo médio ponderado das saídas/entradas da linha. */
  unitCost: string
}

export interface ReturnFilter {
  direction?: ReturnDirection
  status?: ReturnStatus
  limit: number
  offset: number
}

export interface ReturnStore {
  list(scope: TenantScope, filter: ReturnFilter): Promise<{ items: GoodsReturn[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<GoodsReturn | null>
  insert(
    scope: TenantScope,
    values: {
      organizationId: string
      direction: ReturnDirection
      sourceDocumentId: string
      warehouseId: string
      reason: string
    }
  ): Promise<GoodsReturn>
  setStatus(
    scope: TenantScope,
    id: string,
    patch: { status: 'APPROVED' } | { status: 'POSTED'; number: string }
  ): Promise<GoodsReturn>
  remove(scope: TenantScope, id: string): Promise<void>
  lines(scope: TenantScope, returnId: string): Promise<ReturnLine[]>
  insertLine(
    scope: TenantScope,
    returnId: string,
    values: {
      sourceLineId: string
      variantId: string
      lotId: string | null
      locationId: string | null
      quantity: string
      condition: ReturnCondition
    }
  ): Promise<ReturnLine>
  removeLine(scope: TenantScope, returnId: string, lineId: string): Promise<boolean>
  /** Linhas do documento de origem segundo o livro (`SHIPMENT`/`ISSUE` ou `GOODS_RECEIPT`/`RECEIPT`), líquidas. */
  sourceLines(
    scope: TenantScope,
    sourceType: 'SHIPMENT' | 'GOODS_RECEIPT',
    sourceDocumentId: string
  ): Promise<SourceLine[]>
  /** Quantidade já devolvida (devoluções aprovadas ou lançadas) por linha de origem. */
  returnedBySourceLine(
    scope: TenantScope,
    sourceDocumentId: string,
    exceptReturnId?: string
  ): Promise<Map<string, string>>
  /** Serializa as devoluções do mesmo documento de origem até ao fim da transacção. */
  lockSource(scope: TenantScope, sourceDocumentId: string): Promise<void>
}
