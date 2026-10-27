import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { RoundingMode, Totals } from '#modules/orders/domain/money'
import type {
  OrderHeaderValues,
  OrderStatus,
  QuoteHeaderValues,
  QuoteStatus,
} from '#modules/orders/domain/sales'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

/** De onde veio o preço de uma linha: guardado com ela para o documento ser autónomo (instantâneo). */
export interface PriceOrigin {
  priceListId: string
  priceListName: string
  priority: number
  minQuantity: string
  maxDiscount: string
  taxInclusive: boolean
  validFrom: string
  validTo: string | null
  /** A data para a qual o preço foi resolvido. */
  resolvedOn: string
}

export interface LineValues {
  variantId: string
  descriptionSnapshot: string
  quantity: string
  unitId: string
  unitPrice: string
  discountRate: string
  taxRateSnapshot: string
  taxInclusive: boolean
  netAmount: string
  taxAmount: string
  total: string
  priceOrigin: PriceOrigin
}

export interface Line extends Audited, LineValues {
  position: number
}

export interface Quote extends Audited, QuoteHeaderValues {
  number: string | null
  /** O estado gravado; a API mostra o efectivo (uma proposta enviada que passou da validade é `EXPIRED`). */
  status: QuoteStatus
  totals: Totals
}

export interface Order extends Audited, OrderHeaderValues {
  number: string | null
  quoteId: string | null
  status: OrderStatus
  /** Compromisso de crédito ainda não facturado: fica a zero até haver verificação de crédito (4.6). */
  creditReservation: string
  totals: Totals
  confirmedAt: string | null
  cancelledAt: string | null
  cancelReason: string | null
}

export type Owner = { quoteId: string } | { orderId: string }

export interface DocumentFilter {
  customerId?: string
  organizationId?: string
  status?: string
  /** Número do documento (parcial). */
  q?: string
  today: string
  limit: number
  offset: number
}

export interface QuoteStore {
  list(scope: TenantScope, filter: DocumentFilter): Promise<{ items: Quote[]; total: number }>
  /** `lock` bloqueia a linha até ao fim da transacção (serializa linhas, envio e aceitação). */
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Quote | null>
  insert(scope: TenantScope, values: QuoteHeaderValues): Promise<Quote>
  updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: QuoteHeaderValues
  ): Promise<Quote>
  setTotals(scope: TenantScope, id: string, totals: Totals): Promise<Quote>
  transition(
    scope: TenantScope,
    id: string,
    to: { status: QuoteStatus; number?: string }
  ): Promise<Quote>
}

export interface OrderStore {
  list(scope: TenantScope, filter: DocumentFilter): Promise<{ items: Order[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Order | null>
  findByQuote(scope: TenantScope, quoteId: string): Promise<Order | null>
  insert(scope: TenantScope, values: OrderHeaderValues, quoteId: string | null): Promise<Order>
  updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: OrderHeaderValues
  ): Promise<Order>
  setTotals(scope: TenantScope, id: string, totals: Totals): Promise<Order>
  confirm(scope: TenantScope, id: string, number: string): Promise<Order>
  cancel(scope: TenantScope, id: string, reason: string): Promise<Order>
}

export interface LineStore {
  list(scope: TenantScope, owner: Owner): Promise<Line[]>
  find(scope: TenantScope, owner: Owner, id: string): Promise<Line | null>
  insert(scope: TenantScope, owner: Owner, values: LineValues): Promise<Line>
  update(scope: TenantScope, id: string, values: LineValues): Promise<Line>
  remove(scope: TenantScope, id: string): Promise<void>
}

export interface CustomerRef {
  id: string
  organizationId: string
  currency: string
  status: string
}

export interface VariantRef {
  id: string
  sku: string
  attributes: Record<string, string | number | boolean>
  active: boolean
  product: {
    id: string
    name: string
    baseUnitId: string
    taxCategory: string | null
    active: boolean
  }
}

export interface ResolvedPriceRef {
  priceListId: string
  priceListName: string
  priority: number
  taxInclusive: boolean
  minQuantity: string
  unitPrice: string
  maxDiscount: string
  validFrom: string
  validTo: string | null
}

export interface TaxRateRef {
  code: string
  rate: string
  category: string
}

/** Outros módulos, vistos pelas suas APIs públicas. */
export interface References {
  organizationExists(context: TenantContext, organizationId: string): Promise<boolean>
  /** `null` se o cliente não existir neste tenant. */
  customer(context: TenantContext, customerId: string): Promise<CustomerRef | null>
  /** Lança 409 `CUSTOMER_BLOCKED`/`CUSTOMER_INACTIVE` (clientes) se o cliente não pode receber vendas. */
  assertSaleAllowed(context: TenantContext, customerId: string): Promise<void>
  variant(context: TenantContext, variantId: string): Promise<VariantRef | null>
  /** Lança os erros do catálogo (`PRICE_NOT_FOUND`, `PRICE_AMBIGUOUS`, `VARIANT_INACTIVE`). */
  resolvePrice(
    context: TenantContext,
    query: {
      variantId: string
      organizationId: string
      currency: string
      quantity: string
      date: string
    }
  ): Promise<ResolvedPriceRef>
  taxRates(context: TenantContext, organizationId: string, date: string): Promise<TaxRateRef[]>
  /** Casas decimais que a unidade admite (`null` se a unidade não existir). */
  unitPrecision(context: TenantContext, unitId: string): Promise<number | null>
  roundingMode(context: TenantContext, organizationId: string): Promise<RoundingMode>
  /** Emite o número dentro da transacção do documento (sem lacunas se a transacção anular). */
  issueNumber(
    scope: TenantScope,
    input: { organizationId: string; documentType: 'QUOTE' | 'SALES_ORDER'; date: Date }
  ): Promise<string>
}
