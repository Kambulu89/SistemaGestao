import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { RoundingMode } from '#modules/procurement/domain/decimal'
import type {
  PurchaseLineValues,
  PurchaseStatus,
  ReceiptLineValues,
  ReceiptStatus,
  RequisitionStatus,
  SupplierStatus,
  SupplierValues,
} from '#modules/procurement/domain/procurement'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface Totals {
  net: string
  tax: string
  total: string
}

// --- fornecedores -----------------------------------------------------------------------------------

/** Nome e NIF vêm da Party por junção de leitura: o fornecedor nunca escreve na Party. */
export interface Supplier extends Audited, SupplierValues {
  partyName: string
  taxId: string | null
}

export interface SupplierFilter {
  q?: string
  status?: SupplierStatus
  organizationId?: string
  limit: number
  offset: number
}

export interface SupplierStore {
  list(scope: TenantScope, filter: SupplierFilter): Promise<{ items: Supplier[]; total: number }>
  find(scope: TenantScope, id: string): Promise<Supplier | null>
  /** `'CODE'` ou `'PARTY'` se já existir. */
  insert(scope: TenantScope, values: SupplierValues): Promise<Supplier | 'CODE' | 'PARTY'>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: SupplierValues
  ): Promise<Supplier>
}

// --- requisições ------------------------------------------------------------------------------------

export interface Requisition extends Audited {
  organizationId: string
  requestedByMembershipId: string
  number: string | null
  status: RequisitionStatus
  neededOn: string | null
  notes: string | null
  decidedByMembershipId: string | null
  decidedAt: Date | null
  decisionReason: string | null
  purchaseOrderId: string | null
}

export interface RequisitionLine extends Audited {
  requisitionId: string
  position: number
  variantId: string
  description: string
  quantity: string
}

export interface RequisitionFilter {
  status?: RequisitionStatus
  requestedByMembershipId?: string
  limit: number
  offset: number
}

export interface RequisitionStore {
  list(
    scope: TenantScope,
    filter: RequisitionFilter
  ): Promise<{ items: Requisition[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Requisition | null>
  insert(
    scope: TenantScope,
    values: {
      organizationId: string
      requestedByMembershipId: string
      neededOn: string | null
      notes: string | null
    }
  ): Promise<Requisition>
  updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: { neededOn: string | null; notes: string | null }
  ): Promise<Requisition>
  remove(scope: TenantScope, id: string): Promise<void>
  submit(scope: TenantScope, id: string, number: string): Promise<Requisition>
  decide(
    scope: TenantScope,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    by: string,
    reason: string | null
  ): Promise<Requisition>
  markConverted(scope: TenantScope, id: string, orderId: string): Promise<Requisition>
  listLines(scope: TenantScope, requisitionId: string): Promise<RequisitionLine[]>
  findLine(
    scope: TenantScope,
    requisitionId: string,
    lineId: string
  ): Promise<RequisitionLine | null>
  /** `null` se a variante já está na requisição. */
  insertLine(
    scope: TenantScope,
    requisitionId: string,
    values: { variantId: string; description: string; quantity: string }
  ): Promise<RequisitionLine | null>
  removeLine(scope: TenantScope, id: string): Promise<void>
}

// --- encomendas a fornecedor ------------------------------------------------------------------------

export interface PurchaseOrder extends Audited {
  organizationId: string
  supplierId: string
  requisitionId: string | null
  number: string | null
  orderDate: string
  currency: string
  status: PurchaseStatus
  notes: string | null
  totals: Totals
  orderedAt: Date | null
  cancelledAt: Date | null
  cancelReason: string | null
}

export interface PurchaseLine extends Audited, PurchaseLineValues {
  orderId: string
  position: number
  description: string
}

export interface PurchaseFilter {
  supplierId?: string
  status?: PurchaseStatus
  q?: string
  limit: number
  offset: number
}

export interface PurchaseStore {
  list(
    scope: TenantScope,
    filter: PurchaseFilter
  ): Promise<{ items: PurchaseOrder[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<PurchaseOrder | null>
  insert(
    scope: TenantScope,
    values: {
      organizationId: string
      supplierId: string
      requisitionId: string | null
      orderDate: string
      currency: string
      notes: string | null
    }
  ): Promise<PurchaseOrder>
  updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: { orderDate: string; notes: string | null }
  ): Promise<PurchaseOrder>
  setTotals(scope: TenantScope, id: string, totals: Totals): Promise<PurchaseOrder>
  /** Rascunho → encomendada, com número. */
  confirm(scope: TenantScope, id: string, number: string): Promise<PurchaseOrder>
  setStatus(
    scope: TenantScope,
    id: string,
    status: Extract<PurchaseStatus, 'ORDERED' | 'PARTIAL' | 'RECEIVED'>
  ): Promise<PurchaseOrder>
  cancel(scope: TenantScope, id: string, reason: string): Promise<PurchaseOrder>
  remove(scope: TenantScope, id: string): Promise<void>
  listLines(scope: TenantScope, orderId: string): Promise<PurchaseLine[]>
  findLine(scope: TenantScope, orderId: string, lineId: string): Promise<PurchaseLine | null>
  insertLine(
    scope: TenantScope,
    orderId: string,
    description: string,
    values: PurchaseLineValues
  ): Promise<PurchaseLine>
  removeLine(scope: TenantScope, id: string): Promise<void>
  /** Serializa as operações de uma encomenda (recepções concorrentes) até ao fim da transacção. */
  lock(scope: TenantScope, orderId: string): Promise<void>
}

// --- recepções --------------------------------------------------------------------------------------

export interface Receipt extends Audited {
  organizationId: string
  purchaseOrderId: string
  warehouseId: string | null
  number: string | null
  status: ReceiptStatus
  supplierDocument: string | null
  notes: string | null
  receivedAt: Date | null
  reversedAt: Date | null
  reverseReason: string | null
}

export interface ReceiptLine extends Audited, ReceiptLineValues {
  receiptId: string
}

export interface ReceiptFilter {
  purchaseOrderId?: string
  status?: ReceiptStatus
  limit: number
  offset: number
}

export interface ReceiptStore {
  list(scope: TenantScope, filter: ReceiptFilter): Promise<{ items: Receipt[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Receipt | null>
  insert(
    scope: TenantScope,
    values: {
      organizationId: string
      purchaseOrderId: string
      warehouseId: string | null
      supplierDocument: string | null
      notes: string | null
    }
  ): Promise<Receipt>
  updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: { warehouseId: string | null; supplierDocument: string | null; notes: string | null }
  ): Promise<Receipt>
  remove(scope: TenantScope, id: string): Promise<void>
  post(scope: TenantScope, id: string, number: string): Promise<Receipt>
  reverse(scope: TenantScope, id: string, reason: string): Promise<Receipt>
  listLines(scope: TenantScope, receiptId: string): Promise<ReceiptLine[]>
  findLine(scope: TenantScope, receiptId: string, lineId: string): Promise<ReceiptLine | null>
  /** `null` se a linha da encomenda já está na recepção. */
  insertLine(
    scope: TenantScope,
    receiptId: string,
    values: ReceiptLineValues
  ): Promise<ReceiptLine | null>
  removeLine(scope: TenantScope, id: string): Promise<void>
  /** Quantidade recebida por linha da encomenda: recepções lançadas e não revertidas. */
  receivedByLine(scope: TenantScope, orderId: string): Promise<Map<string, string>>
}

// --- outros módulos ---------------------------------------------------------------------------------

export interface VariantRef {
  id: string
  sku: string
  description: string
  active: boolean
  trackStock: boolean
}

/** Outros módulos, vistos pelas suas APIs públicas. */
export interface References {
  /** A moeda base da organização; `null` se não existir neste tenant. */
  organizationCurrency(context: TenantContext, organizationId: string): Promise<string | null>
  partyExists(context: TenantContext, partyId: string): Promise<boolean>
  /** `null` se a variante não existir neste tenant. */
  variant(context: TenantContext, variantId: string): Promise<VariantRef | null>
  /** `true` se o armazém existe neste tenant e pertence à organização. */
  warehouseUsable(
    context: TenantContext,
    warehouseId: string,
    organizationId: string
  ): Promise<boolean>
  roundingMode(context: TenantContext, organizationId: string): Promise<RoundingMode>
  /** Emite o número dentro da transacção do documento (sem lacunas se a transacção anular). */
  issueNumber(
    scope: TenantScope,
    input: {
      organizationId: string
      documentType: 'PURCHASE_REQUISITION' | 'PURCHASE_ORDER' | 'GOODS_RECEIPT'
      date: Date
    }
  ): Promise<string>
}
