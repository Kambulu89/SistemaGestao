import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { RoundingMode, Totals } from '#modules/orders/index'
import type {
  ContractStatus,
  ContractValues,
  CreditNoteStatus,
  InvoiceLineValues,
  InvoiceStatus,
} from '#modules/invoicing/domain/invoicing'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface Contract extends Audited, ContractValues {
  number: string | null
  /** O estado gravado (`DRAFT`, `ACTIVE` ou `TERMINATED`); a API mostra o efectivo (`EXPIRED` é derivado). */
  status: Exclude<ContractStatus, 'EXPIRED'>
  activatedAt: Date | null
  terminatedAt: Date | null
  terminateReason: string | null
}

export interface ContractFilter {
  partyId?: string
  type?: string
  status?: string
  q?: string
  today: string
  limit: number
  offset: number
}

export interface ContractStore {
  list(scope: TenantScope, filter: ContractFilter): Promise<{ items: Contract[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Contract | null>
  insert(scope: TenantScope, values: ContractValues): Promise<Contract>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: ContractValues
  ): Promise<Contract>
  activate(scope: TenantScope, id: string, number: string): Promise<Contract>
  terminate(scope: TenantScope, id: string, reason: string): Promise<Contract>
}

/** O cliente e a morada de facturação como estavam ao emitir: mudar o cliente depois não mexe na factura. */
export interface CustomerSnapshot {
  customerId: string
  customerCode: string
  partyId: string
  name: string
  taxCountry: string | null
  taxId: string | null
  billingAddress: {
    line1: string
    line2: string | null
    city: string
    postalCode: string | null
    countryCode: string
  } | null
}

export interface Invoice extends Audited {
  organizationId: string
  customerId: string
  contractId: string | null
  orderId: string | null
  number: string | null
  issuedOn: string | null
  dueOn: string
  currency: string
  exchangeRate: string
  customerSnapshot: CustomerSnapshot | null
  roundingMode: RoundingMode | null
  totals: Totals
  status: InvoiceStatus
  fiscalStatus: 'NOT_REQUIRED' | 'PENDING' | 'ACCEPTED' | 'REJECTED'
  issuedAt: Date | null
  notes: string | null
}

export interface InvoiceLine extends Audited, InvoiceLineValues {
  invoiceId: string
  position: number
}

export interface InvoiceHeaderValues {
  organizationId: string
  customerId: string
  contractId: string | null
  orderId: string | null
  dueOn: string
  currency: string
  notes: string | null
}

export interface InvoiceFilter {
  customerId?: string
  orderId?: string
  contractId?: string
  status?: InvoiceStatus
  q?: string
  limit: number
  offset: number
}

export interface InvoiceStore {
  list(scope: TenantScope, filter: InvoiceFilter): Promise<{ items: Invoice[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Invoice | null>
  insert(scope: TenantScope, values: InvoiceHeaderValues): Promise<Invoice>
  updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Pick<InvoiceHeaderValues, 'dueOn' | 'notes' | 'contractId'>
  ): Promise<Invoice>
  setTotals(scope: TenantScope, id: string, totals: Totals): Promise<Invoice>
  issue(
    scope: TenantScope,
    id: string,
    values: {
      number: string
      issuedOn: string
      snapshot: CustomerSnapshot
      roundingMode: RoundingMode
    }
  ): Promise<Invoice>
  markCredited(scope: TenantScope, id: string): Promise<Invoice>
  /** Só um rascunho se apaga (as linhas vão primeiro). */
  remove(scope: TenantScope, id: string): Promise<void>
  listLines(scope: TenantScope, invoiceId: string): Promise<InvoiceLine[]>
  findLine(scope: TenantScope, invoiceId: string, lineId: string): Promise<InvoiceLine | null>
  /** A posição é a seguinte à última (única por factura). */
  insertLine(scope: TenantScope, invoiceId: string, values: InvoiceLineValues): Promise<InvoiceLine>
  removeLine(scope: TenantScope, id: string): Promise<void>
  /** Quantidade facturada por linha da encomenda: linhas de facturas emitidas menos o creditado. */
  billedByOrderLine(scope: TenantScope, orderId: string): Promise<Map<string, string>>
  /** Serializa as operações de facturação de uma chave (encomenda ou factura) até ao fim da transacção. */
  lock(scope: TenantScope, key: string): Promise<void>
}

export interface CreditNote extends Audited {
  organizationId: string
  invoiceId: string
  number: string | null
  issuedOn: string | null
  reason: string
  totals: Totals
  status: CreditNoteStatus
  issuedAt: Date | null
}

export interface CreditNoteLine extends Audited {
  creditNoteId: string
  invoiceLineId: string
  quantity: string
  amount: string
  taxAmount: string
}

export interface CreditedAmounts {
  quantity: string
  net: string
  tax: string
}

export interface CreditNoteStore {
  list(
    scope: TenantScope,
    filter: { invoiceId?: string; status?: CreditNoteStatus; limit: number; offset: number }
  ): Promise<{ items: CreditNote[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<CreditNote | null>
  insert(
    scope: TenantScope,
    values: { organizationId: string; invoiceId: string; reason: string }
  ): Promise<CreditNote>
  setReason(scope: TenantScope, id: string, reason: string): Promise<CreditNote>
  setTotals(scope: TenantScope, id: string, totals: Totals): Promise<CreditNote>
  issue(scope: TenantScope, id: string, number: string, issuedOn: string): Promise<CreditNote>
  remove(scope: TenantScope, id: string): Promise<void>
  listLines(scope: TenantScope, creditNoteId: string): Promise<CreditNoteLine[]>
  findLine(scope: TenantScope, creditNoteId: string, lineId: string): Promise<CreditNoteLine | null>
  /** `null` se a linha da factura já está na nota. */
  insertLine(
    scope: TenantScope,
    creditNoteId: string,
    values: { invoiceLineId: string; quantity: string; amount: string; taxAmount: string }
  ): Promise<CreditNoteLine | null>
  removeLine(scope: TenantScope, id: string): Promise<void>
  /** Quantidade, líquido e imposto já creditados por linha da factura (só notas emitidas). */
  creditedByInvoiceLine(
    scope: TenantScope,
    invoiceId: string
  ): Promise<Map<string, CreditedAmounts>>
}

export interface CustomerRef {
  id: string
  code: string
  organizationId: string
  partyId: string
  currency: string
  paymentTermDays: number
  partyName: string
  taxId: string | null
}

export interface OrderLineRef {
  id: string
  variantId: string
  description: string
  quantity: string
  unitPrice: string
  discountRate: string
  taxRate: string
  taxInclusive: boolean
  shippedQty: string
}

export interface OrderRef {
  id: string
  organizationId: string
  customerId: string
  currency: string
  status: string
  lines: OrderLineRef[]
}

/** Outros módulos, vistos pelas suas APIs públicas. */
export interface References {
  /** A moeda base da organização; `null` se não existir neste tenant. */
  organizationCurrency(context: TenantContext, organizationId: string): Promise<string | null>
  partyExists(context: TenantContext, partyId: string): Promise<boolean>
  /** `null` se o cliente não existir neste tenant. */
  customer(context: TenantContext, customerId: string): Promise<CustomerRef | null>
  /** A morada de facturação principal e o país fiscal da Party do cliente. */
  customerSnapshot(context: TenantContext, customer: CustomerRef): Promise<CustomerSnapshot>
  /** `null` se a encomenda não existir neste tenant. */
  order(context: TenantContext, orderId: string): Promise<OrderRef | null>
  /** `true` se o produto da variante controla stock (a facturação segue então a expedição). */
  stockTracked(context: TenantContext, variantId: string): Promise<boolean>
  roundingMode(context: TenantContext, organizationId: string): Promise<RoundingMode>
  /** Emite o número dentro da transacção do documento (sem lacunas se a transacção anular). */
  issueNumber(
    scope: TenantScope,
    input: {
      organizationId: string
      documentType: 'INVOICE' | 'CREDIT_NOTE' | 'CONTRACT'
      date: Date
    }
  ): Promise<string>
}
