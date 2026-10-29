import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { RoundingMode } from '#core/decimal/index'
import type {
  AccountValues,
  AllocationValues,
  InvoiceTotals,
  ObligationKind,
  ObligationStatus,
  ObligationView,
  PaymentStatus,
  PaymentValues,
  SupplierInvoiceHeaderValues,
  SupplierInvoiceLineValues,
  SupplierInvoiceStatus,
} from '#modules/finance/domain/finance'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

// --- contas ------------------------------------------------------------------------------------------

/** `balance` deriva dos movimentos de tesouraria; nunca se edita. */
export interface TreasuryAccount extends Audited, AccountValues {
  balance: string
}

export interface AccountFilter {
  organizationId?: string
  active?: boolean
  limit: number
  offset: number
}

export interface AccountStore {
  list(
    scope: TenantScope,
    filter: AccountFilter
  ): Promise<{ items: TreasuryAccount[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<TreasuryAccount | null>
  insert(scope: TenantScope, values: AccountValues): Promise<TreasuryAccount | 'CODE'>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: AccountValues
  ): Promise<TreasuryAccount>
}

export interface TreasuryEntry {
  id: string
  accountId: string
  paymentId: string | null
  amountSigned: string
  occurredOn: string
  reversalOfId: string | null
  createdAt: Date
}

// --- obrigações --------------------------------------------------------------------------------------

export interface Obligation extends Audited {
  kind: ObligationKind
  organizationId: string
  partyId: string
  partyName: string
  sourceType: string
  sourceId: string
  installmentNo: number
  originalAmount: string
  currency: string
  dueOn: string
  status: ObligationStatus
  closedAt: Date | null
  credits: string
  paid: string
  balance: string
  /** Estado mostrado (aberto, parcial, vencido, liquidado, cancelado). */
  view: ObligationView
}

export interface ObligationFilter {
  partyId?: string
  organizationId?: string
  view?: ObligationView
  sourceId?: string
  dueBefore?: string
  today: string
  limit: number
  offset: number
}

export interface ObligationInsert {
  organizationId: string
  partyId: string
  sourceType: string
  sourceId: string
  installmentNo: number
  originalAmount: string
  currency: string
  dueOn: string
}

export interface ObligationAllocation {
  id: string
  paymentId: string
  paymentStatus: PaymentStatus
  amount: string
  reversedAt: Date | null
  occurredOn: string
}

export interface ObligationCredit {
  id: string
  sourceType: string
  sourceId: string
  amount: string
  createdAt: Date
}

export interface ObligationStore {
  list(
    scope: TenantScope,
    kind: ObligationKind,
    filter: ObligationFilter
  ): Promise<{ items: Obligation[]; total: number }>
  /** `lock` bloqueia a linha até ao fim da transacção (serializa pagamentos e créditos sobre a obrigação). */
  find(
    scope: TenantScope,
    kind: ObligationKind,
    id: string,
    today: string,
    lock?: boolean
  ): Promise<Obligation | null>
  findBySource(
    scope: TenantScope,
    kind: ObligationKind,
    sourceType: string,
    sourceId: string,
    today: string
  ): Promise<Obligation | null>
  /** Insere; devolve `null` se a obrigação (fonte + prestação) já existir (idempotência). */
  insert(scope: TenantScope, kind: ObligationKind, values: ObligationInsert): Promise<string | null>
  setStatus(
    scope: TenantScope,
    kind: ObligationKind,
    id: string,
    status: ObligationStatus
  ): Promise<void>
  allocations(scope: TenantScope, kind: ObligationKind, id: string): Promise<ObligationAllocation[]>
  credits(scope: TenantScope, receivableId: string): Promise<ObligationCredit[]>
  insertCredit(
    scope: TenantScope,
    values: { receivableId: string; sourceType: string; sourceId: string; amount: string }
  ): Promise<boolean>
}

// --- pagamentos --------------------------------------------------------------------------------------

export interface Payment extends Audited {
  organizationId: string
  direction: PaymentValues['direction']
  partyId: string
  partyName: string
  treasuryAccountId: string
  amount: string
  currency: string
  method: PaymentValues['method']
  occurredOn: string
  reference: string | null
  status: PaymentStatus
  provider: string | null
  providerReference: string | null
  confirmedAt: Date | null
  reversedAt: Date | null
  reverseReason: string | null
  failureReason: string | null
}

export interface PaymentAllocation extends AllocationValues {
  id: string
  paymentId: string
  reversedAt: Date | null
}

export interface PaymentFilter {
  direction?: PaymentValues['direction']
  status?: PaymentStatus
  partyId?: string
  treasuryAccountId?: string
  limit: number
  offset: number
}

export interface PaymentStore {
  list(scope: TenantScope, filter: PaymentFilter): Promise<{ items: Payment[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Payment | null>
  findByIdempotencyKey(scope: TenantScope, key: string): Promise<Payment | null>
  /** Devolve `'KEY'` se a chave de idempotência já existir (corrida entre dois pedidos iguais). */
  insert(
    scope: TenantScope,
    values: PaymentValues,
    idempotencyKey: string | null
  ): Promise<Payment | 'KEY'>
  allocations(scope: TenantScope, paymentId: string): Promise<PaymentAllocation[]>
  setStatus(
    scope: TenantScope,
    id: string,
    patch:
      | { status: 'PENDING' }
      | { status: 'CONFIRMED' }
      | { status: 'FAILED'; reason: string }
      | { status: 'REVERSED'; reason: string }
  ): Promise<Payment>
  markAllocationsReversed(scope: TenantScope, paymentId: string): Promise<void>
  remove(scope: TenantScope, id: string): Promise<void>
  insertEntry(
    scope: TenantScope,
    values: {
      accountId: string
      paymentId: string
      amountSigned: string
      occurredOn: string
      reversalOfId: string | null
      sourceKey: string
    }
  ): Promise<void>
  entryOf(scope: TenantScope, paymentId: string): Promise<TreasuryEntry | null>
  entries(
    scope: TenantScope,
    accountId: string,
    limit: number,
    offset: number
  ): Promise<{ items: TreasuryEntry[]; total: number }>
}

// --- facturas de fornecedor --------------------------------------------------------------------------

export interface Discrepancy {
  line: string
  code: string
  message: string
}

export interface SupplierInvoice extends Audited, SupplierInvoiceHeaderValues {
  supplierName: string
  status: SupplierInvoiceStatus
  totals: InvoiceTotals
  matching: Discrepancy[] | null
  overrideReason: string | null
  validatedAt: Date | null
}

export interface SupplierInvoiceLine extends Audited, SupplierInvoiceLineValues {
  supplierInvoiceId: string
  position: number
}

export interface SupplierInvoiceFilter {
  supplierId?: string
  status?: SupplierInvoiceStatus
  q?: string
  limit: number
  offset: number
}

export interface SupplierInvoiceStore {
  list(
    scope: TenantScope,
    filter: SupplierInvoiceFilter
  ): Promise<{ items: SupplierInvoice[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<SupplierInvoice | null>
  /** Devolve `'NUMBER'` se o fornecedor já tem uma factura com este número. */
  insert(
    scope: TenantScope,
    values: SupplierInvoiceHeaderValues
  ): Promise<SupplierInvoice | 'NUMBER'>
  updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: SupplierInvoiceHeaderValues
  ): Promise<SupplierInvoice | 'NUMBER'>
  lines(scope: TenantScope, id: string): Promise<SupplierInvoiceLine[]>
  insertLine(scope: TenantScope, id: string, line: SupplierInvoiceLineValues): Promise<void>
  removeLine(scope: TenantScope, id: string, lineId: string): Promise<boolean>
  setTotals(scope: TenantScope, id: string, totals: InvoiceTotals): Promise<void>
  setValidation(
    scope: TenantScope,
    id: string,
    patch:
      | { status: 'VALIDATED'; matching: Discrepancy[] | null; overrideReason: string | null }
      | { status: 'DISPUTED'; matching: Discrepancy[] }
      | { status: 'VOID' }
  ): Promise<SupplierInvoice>
  /** Quantidade já facturada em facturas validadas (excluindo `exceptInvoiceId`), por linha de compra. */
  invoicedByPurchaseLine(
    scope: TenantScope,
    purchaseLineIds: readonly string[],
    exceptInvoiceId: string
  ): Promise<Map<string, string>>
  remove(scope: TenantScope, id: string): Promise<void>
}

// --- crédito -----------------------------------------------------------------------------------------

export interface CreditCustomer {
  id: string
  partyId: string
  organizationId: string
  creditLimit: string
  currency: string
  status: string
}

export interface CreditExposure {
  openReceivables: string
  reservations: string
  exposure: string
}

export interface CreditStore {
  /** Leitura do cliente (limite, moeda, Party); `null` se não existir neste tenant. */
  customer(scope: TenantScope, customerId: string): Promise<CreditCustomer | null>
  /** Serializa as decisões de crédito de um cliente até ao fim da transacção. */
  lockCustomer(scope: TenantScope, customerId: string): Promise<void>
  exposure(scope: TenantScope, customer: CreditCustomer): Promise<CreditExposure>
  insertReservation(
    scope: TenantScope,
    values: {
      organizationId: string
      customerId: string
      orderId: string
      currency: string
      amount: string
    }
  ): Promise<void>
  releaseReservation(scope: TenantScope, orderId: string): Promise<void>
  consumeReservation(scope: TenantScope, orderId: string, amount: string): Promise<void>
}

// --- referências a outros módulos --------------------------------------------------------------------

export interface SupplierRef {
  id: string
  partyId: string
  organizationId: string
  paymentTermDays: number
  currency: string
  status: string
}

export interface PurchaseOrderRef {
  id: string
  organizationId: string
  supplierId: string
  currency: string
  status: string
  lines: { id: string; unitCost: string; receivedQty: string }[]
}

export interface References {
  organizationCurrency(context: TenantContext, organizationId: string): Promise<string | null>
  partyExists(context: TenantContext, partyId: string): Promise<boolean>
  supplier(context: TenantContext, supplierId: string): Promise<SupplierRef | null>
  purchaseOrder(context: TenantContext, orderId: string): Promise<PurchaseOrderRef | null>
  roundingMode(context: TenantContext, organizationId: string): Promise<RoundingMode>
}

export type { AllocationValues }
