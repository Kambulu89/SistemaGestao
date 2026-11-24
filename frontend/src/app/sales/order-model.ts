/** Encomendas de venda (10.4): tipos, rótulos e conversões. */
import { emptyLine, type LineForm } from './quote-model';

export type OrderStatus = 'DRAFT' | 'CONFIRMED' | 'CLOSED' | 'CANCELLED';

export interface OrderRow {
  id: string;
  number: string | null;
  customer: { code: string; name: string };
  legalEntity: string;
  orderDate: string;
  requestedDate: string | null;
  currency: string;
  grossTotal: string;
  status: OrderStatus;
  approvalStatus: string;
  reservationStatus: string;
  deliveryStatus: string;
  invoicingStatus: string;
}

export interface OrderLine {
  id: string;
  lineNo: number;
  product: { id: string; sku: string };
  variant: { id: string; sku: string } | null;
  description: string;
  isStock: boolean;
  quantity: string;
  reservedQty: string;
  deliveredQty: string;
  invoicedQty: string;
  returnedQty: string;
  returnCreditedQty: string;
  closedQty: string;
  openQty: string;
  manualDiscountPct: string | null;
  manualUnitPrice: string | null;
  taxRate: string;
  taxExemptionReason: string | null;
  priceSource: string;
  basePrice: string | null;
  netUnitPrice: string | null;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  requiresApproval: boolean;
  pricing: { reasons?: string[]; priceListCode?: string | null; ruleCode?: string | null };
  quoteLineNo: number | null;
}

export interface Order {
  id: string;
  version: number;
  number: string | null;
  status: OrderStatus;
  approvalStatus: string;
  reservationStatus: string;
  deliveryStatus: string;
  invoicingStatus: string;
  approvalReasons: string[];
  creditCheck: {
    limit: string | null;
    openOrders: string;
    thisOrder: string;
    exposure: string;
    exceeded: boolean;
    currency: string;
    missingRates: string[];
  } | null;
  legalEntity: { id: string; code: string; name: string };
  customer: { id: string; code: string; name: string; status: string };
  salesperson: { membershipId: string; name: string };
  warehouse: { id: string; code: string; name: string } | null;
  deliveryAddress: { id: string; label: string; line: string } | null;
  quote: { id: string; number: string; versionNo: number } | null;
  orderDate: string;
  requestedDate: string | null;
  currency: string;
  paymentTermsDays: number;
  customerReference: string | null;
  notes: string | null;
  netTotal: string;
  taxTotal: string;
  grossTotal: string;
  closedReason: string | null;
  lines: OrderLine[];
  deliveries: {
    id: string;
    seq: number;
    reference: string;
    deliveryDate: string;
    stockEventId: string | null;
    notes: string | null;
    lines: { lineNo: number; quantity: string }[];
    at: string;
    by: string | null;
  }[];
  returns: {
    id: string;
    seq: number;
    reference: string;
    returnDate: string;
    reason: string;
    stockEventId: string | null;
    lines: { lineNo: number; quantity: string }[];
    at: string;
    by: string | null;
  }[];
  history: {
    kind: string;
    reason: string | null;
    details: Record<string, unknown> | null;
    at: string;
    by: string | null;
  }[];
  can: Record<
    | 'edit'
    | 'editLines'
    | 'submit'
    | 'approve'
    | 'reject'
    | 'reserve'
    | 'release'
    | 'deliver'
    | 'close'
    | 'cancel'
    | 'returnGoods',
    boolean
  >;
}

export interface OrderOptions {
  legalEntities: { id: string; code: string; name: string }[];
  warehouses: { id: string; code: string; name: string; legalEntityId: string }[];
  salespeople: { membershipId: string; name: string }[];
  series: { id: string; code: string; prefix: string; legalEntityId: string }[];
  ownOnly: boolean;
}

export const ORDER_STATUS: Record<OrderStatus, string> = {
  DRAFT: 'Rascunho',
  CONFIRMED: 'Confirmada',
  CLOSED: 'Fechada',
  CANCELLED: 'Anulada',
};
export const APPROVAL_STATUS: Record<string, string> = {
  NOT_REQUIRED: 'Sem aprovação',
  PENDING: 'Aprovação pendente',
  APPROVED: 'Aprovada',
  REJECTED: 'Devolvida',
};
export const RESERVATION_STATUS: Record<string, string> = {
  NONE: 'Sem reserva',
  PARTIAL: 'Reserva parcial',
  FULL: 'Reservada',
  NOT_APPLICABLE: 'Só serviços',
};
export const DELIVERY_STATUS: Record<string, string> = {
  NONE: 'Por entregar',
  PARTIAL: 'Entrega parcial',
  FULL: 'Entregue',
};
export const INVOICING_STATUS: Record<string, string> = {
  NONE: 'Por facturar',
  PARTIAL: 'Facturação parcial',
  FULL: 'Facturada',
};
export const APPROVAL_REASON: Record<string, string> = {
  PRICING: 'Preço ou desconto fora da política',
  CREDIT: 'Limite de crédito ultrapassado',
  NO_RATE: 'Sem câmbio para a moeda do cliente',
};
export const ORDER_EVENT: Record<string, string> = {
  CREATED: 'Criada',
  CREATED_FROM_QUOTE: 'Criada a partir do orçamento',
  SUBMITTED: 'Submetida',
  APPROVED: 'Aprovada',
  REJECTED: 'Devolvida',
  CONFIRMED: 'Confirmada',
  RESERVED: 'Reservada',
  RELEASED: 'Reserva libertada',
  DELIVERED: 'Expedida',
  RETURNED: 'Mercadoria devolvida',
  INVOICED: 'Facturada',
  CLOSED: 'Fechada',
  CANCELLED: 'Anulada',
};

export function orderTone(s: OrderStatus): string {
  if (s === 'CONFIRMED') return 'bg-primary-soft text-on-primary-soft';
  if (s === 'CLOSED') return 'bg-success-soft text-success-text';
  return 'bg-surface-2 text-muted';
}
export function subTone(s: string): string {
  if (['FULL', 'APPROVED'].includes(s)) return 'bg-success-soft text-success-text';
  if (['PARTIAL', 'PENDING'].includes(s)) return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

export interface OrderForm {
  legalEntityId: string;
  customerId: string;
  customerLabel: string;
  salespersonMembershipId: string;
  warehouseId: string;
  deliveryAddressId: string;
  orderDate: string;
  requestedDate: string;
  currency: string;
  paymentTermsDays: string;
  customerReference: string;
  notes: string;
  lines: LineForm[];
}

export function emptyOrderForm(today: string): OrderForm {
  return {
    legalEntityId: '',
    customerId: '',
    customerLabel: '',
    salespersonMembershipId: '',
    warehouseId: '',
    deliveryAddressId: '',
    orderDate: today,
    requestedDate: '',
    currency: '',
    paymentTermsDays: '',
    customerReference: '',
    notes: '',
    lines: [emptyLine()],
  };
}

const plain = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

export function formFromOrder(o: Order): OrderForm {
  return {
    legalEntityId: o.legalEntity.id,
    customerId: o.customer.id,
    customerLabel: `${o.customer.code} — ${o.customer.name}`,
    salespersonMembershipId: o.salesperson.membershipId,
    warehouseId: o.warehouse?.id ?? '',
    deliveryAddressId: o.deliveryAddress?.id ?? '',
    orderDate: o.orderDate,
    requestedDate: o.requestedDate ?? '',
    currency: o.currency,
    paymentTermsDays: String(o.paymentTermsDays),
    customerReference: o.customerReference ?? '',
    notes: o.notes ?? '',
    lines: o.lines.map((l) => ({
      ...emptyLine(),
      productId: l.product.id,
      productLabel: `${l.product.sku} — ${l.description}`,
      description: l.description,
      quantity: plain(l.quantity),
      manualDiscountPct: l.manualDiscountPct === null ? '' : plain(l.manualDiscountPct),
      manualUnitPrice: l.manualUnitPrice === null ? '' : plain(l.manualUnitPrice),
      taxRate: plain(l.taxRate),
      taxExemptionReason: l.taxExemptionReason ?? '',
    })),
  };
}

const nz = (v: string) => (v.trim() === '' ? null : v.trim());
const dec = (v: string) => nz(v)?.replace(',', '.') ?? null;

/** Corpo do pedido; as linhas só vão quando são editáveis (sem orçamento de origem). */
export function orderPayload(f: OrderForm, creating: boolean, withLines: boolean) {
  return {
    ...(creating ? { legalEntityId: f.legalEntityId } : {}),
    ...(withLines ? { customerId: f.customerId } : {}),
    salespersonMembershipId: nz(f.salespersonMembershipId),
    warehouseId: nz(f.warehouseId),
    deliveryAddressId: nz(f.deliveryAddressId),
    orderDate: f.orderDate,
    requestedDate: nz(f.requestedDate),
    ...(nz(f.currency) && withLines ? { currency: f.currency.trim().toUpperCase() } : {}),
    ...(nz(f.paymentTermsDays) && withLines
      ? { paymentTermsDays: Number(f.paymentTermsDays) }
      : {}),
    ...(withLines ? { customerReference: nz(f.customerReference) } : {}),
    notes: nz(f.notes),
    ...(withLines
      ? {
          lines: f.lines.map((l) => ({
            productId: l.productId,
            description: nz(l.description),
            quantity: l.quantity.trim().replace(',', '.'),
            manualDiscountPct: dec(l.manualDiscountPct),
            manualUnitPrice: dec(l.manualUnitPrice),
            taxRate: l.taxRate.trim().replace(',', '.'),
            taxExemptionReason: nz(l.taxExemptionReason),
          })),
        }
      : {}),
  };
}

/** Quantidade (texto com 6 casas) em unidades inteiras, para comparar sem `float`. */
export const qtyUnits = (v: string) => {
  const [i, f = ''] = v.split('.');
  return BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
/** Unidades inteiras de volta a texto com 6 casas. */
export const unitsText = (u: bigint) => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, '0')}`;
};
/** Entregue ainda por facturar: entregue − devolvido − facturado + devolvido já creditado. */
export const invoiceableUnits = (l: {
  deliveredQty: string;
  returnedQty: string;
  invoicedQty: string;
  returnCreditedQty: string;
}) =>
  qtyUnits(l.deliveredQty) -
  qtyUnits(l.returnedQty) -
  qtyUnits(l.invoicedQty) +
  qtyUnits(l.returnCreditedQty);
