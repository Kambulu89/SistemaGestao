/** Ordens de compra (9.5): tipos da API, rótulos dos três estados, cores e cálculo da linha (como no servidor). */
import { scaled } from './requisition-model';

export type ApprovalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type ReceiptStatus = 'NOT_RECEIVED' | 'PARTIALLY_RECEIVED' | 'RECEIVED';
export type InvoiceStatus = 'NOT_INVOICED' | 'PARTIALLY_INVOICED' | 'INVOICED';

export interface OrderRow {
  id: string;
  version: number;
  number: string | null;
  revision: number;
  approvalStatus: ApprovalStatus;
  receiptStatus: ReceiptStatus;
  invoiceStatus: InvoiceStatus;
  issued: boolean;
  closed: boolean;
  legalEntity: { id: string; code: string };
  supplier: { id: string; code: string; name: string };
  orderDate: string;
  expectedDate: string | null;
  currency: string;
  totalAmount: string;
  createdAt: string;
}

export interface OrderLine {
  id: string;
  version: number;
  lineNo: number;
  product: { id: string; sku: string } | null;
  variantId: string | null;
  description: string;
  uom: { id: string; code: string } | null;
  quantity: string;
  unitPrice: string;
  discountRate: string;
  taxRate: string;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  taxAmount: string;
  totalAmount: string;
  expectedDate: string | null;
  notes: string | null;
  requisition: { id: string; number: string; lineId: string } | null;
  awardLineId: string | null;
  allocatedQuantity: string;
  receivedQuantity: string;
  invoicedQuantity: string;
  cancelledQuantity: string;
  openQuantity: string;
}

export interface Order {
  id: string;
  version: number;
  number: string | null;
  revision: number;
  issuedRevision: number | null;
  approvalStatus: ApprovalStatus;
  receiptStatus: ReceiptStatus;
  invoiceStatus: InvoiceStatus;
  closed: boolean;
  legalEntity: { id: string; code: string };
  branch: { id: string; code: string } | null;
  supplier: { id: string; code: string; name: string };
  costCenter: { id: string; code: string; name: string } | null;
  warehouse: { id: string; code: string; name: string } | null;
  award: { id: string; rfqId: string; rfqNumber: string } | null;
  currency: string;
  exchangeRate: string | null;
  rateDate: string | null;
  orderDate: string;
  expectedDate: string | null;
  paymentTermsDays: number | null;
  paymentMethod: string | null;
  incoterm: string | null;
  deliveryTerms: string | null;
  deliveryAddress: string | null;
  supplierReference: string | null;
  notes: string | null;
  totalGross: string;
  totalDiscount: string;
  totalNet: string;
  totalTax: string;
  totalAmount: string;
  totalFunctional: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  approvedAt: string | null;
  issuedAt: string | null;
  issuedBy: string | null;
  rejectReason: string | null;
  cancelReason: string | null;
  closeReason: string | null;
  lines: OrderLine[];
  approval: {
    sequence: number;
    code: string;
    name: string;
    requiresRole: boolean;
    decision: 'APPROVE' | 'REJECT' | null;
    decidedBy: string | null;
    decidedAt: string | null;
    reason: string | null;
    current: boolean;
  }[];
  revisions: {
    revision: number;
    reason: string;
    totalAmount: string;
    at: string;
    by: string | null;
  }[];
  history: {
    kind: string;
    revision: number | null;
    reason: string | null;
    at: string;
    by: string | null;
  }[];
  can: {
    edit: boolean;
    submit: boolean;
    decide: boolean;
    decideBlockedBy: string | null;
    issue: boolean;
    revise: boolean;
    close: boolean;
    cancel: boolean;
  };
}

export interface OrderOptions {
  legalEntities: { id: string; code: string; currency: string }[];
  suppliers: {
    id: string;
    code: string;
    name: string;
    currency: string;
    paymentTermsDays: number | null;
  }[];
  branches: { id: string; code: string; name: string; legalEntityId: string }[];
  costCenters: { id: string; code: string; name: string; legalEntityId: string }[];
  warehouses: { id: string; code: string; name: string; legalEntityId: string }[];
  uoms: { id: string; code: string; name: string }[];
  products: { id: string; sku: string; name: string; productType: string; uomId: string }[];
}

export const APPROVAL_STATUS: Record<ApprovalStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Em aprovação',
  APPROVED: 'Aprovada',
  REJECTED: 'Recusada',
  CANCELLED: 'Anulada',
};
export const RECEIPT_STATUS: Record<ReceiptStatus, string> = {
  NOT_RECEIVED: 'Por receber',
  PARTIALLY_RECEIVED: 'Recebida em parte',
  RECEIVED: 'Recebida',
};
export const INVOICE_STATUS: Record<InvoiceStatus, string> = {
  NOT_INVOICED: 'Por facturar',
  PARTIALLY_INVOICED: 'Facturada em parte',
  INVOICED: 'Facturada',
};
export const PAYMENT_METHOD: Record<string, string> = {
  TRANSFER: 'Transferência',
  CHEQUE: 'Cheque',
  CASH: 'Numerário',
  OTHER: 'Outro',
};
export const ORDER_EVENT: Record<string, string> = {
  CREATED: 'Criada',
  UPDATED: 'Alterada',
  SUBMITTED: 'Aprovação pedida',
  STEP_APPROVED: 'Etapa aprovada',
  APPROVED: 'Aprovada',
  REJECTED: 'Recusada',
  ISSUED: 'Emitida',
  REISSUED: 'Revisão emitida',
  REVISED: 'Revisão aberta',
  CANCELLED: 'Anulada',
  CLOSED: 'Resto fechado',
};

export function approvalTone(s: ApprovalStatus): string {
  if (s === 'APPROVED') return 'bg-success-soft text-success-text';
  if (s === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}
export function progressTone(s: ReceiptStatus | InvoiceStatus): string {
  if (s === 'RECEIVED' || s === 'INVOICED') return 'bg-success-soft text-success-text';
  if (s === 'PARTIALLY_RECEIVED' || s === 'PARTIALLY_INVOICED')
    return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

const divRound = (n: bigint, d: bigint) => (n + d / 2n) / d;
const centsText = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

/** Valores da linha com o arredondamento do servidor; `null` se algo for inválido. */
export function orderLineTotals(
  quantity: string,
  price: string,
  discount: string,
  tax: string,
): { net: string; total: string } | null {
  const q = scaled(quantity, 6);
  const p = scaled(price, 6);
  const d = scaled(discount || '0', 3);
  const t = scaled(tax || '0', 3);
  if (q === null || p === null || d === null || t === null || d > 100_000n || t > 100_000n)
    return null;
  const gross = divRound(q * p * 100n, 10n ** 12n);
  const net = gross - divRound(gross * d, 100_000n);
  const total = net + divRound(net * t, 100_000n);
  return { net: centsText(net), total: centsText(total) };
}

export interface OrderLineForm {
  id: string | null;
  requisitionLineId: string;
  requisitionLabel: string;
  productId: string;
  description: string;
  uomId: string;
  quantity: string;
  unitPrice: string;
  discountRate: string;
  taxRate: string;
  expectedDate: string;
  received: string;
}
export const emptyOrderLine = (): OrderLineForm => ({
  id: null,
  requisitionLineId: '',
  requisitionLabel: '',
  productId: '',
  description: '',
  uomId: '',
  quantity: '1',
  unitPrice: '',
  discountRate: '',
  taxRate: '',
  expectedDate: '',
  received: '0',
});

export function orderLinePayload(l: OrderLineForm) {
  const t = (v: string) => v.trim() || null;
  const n = (v: string) => v.trim().replace(',', '.');
  return {
    id: l.id,
    requisitionLineId: t(l.requisitionLineId),
    productId: t(l.productId),
    description: l.description.trim(),
    uomId: t(l.uomId),
    quantity: n(l.quantity),
    unitPrice: n(l.unitPrice),
    discountRate: n(l.discountRate) || '0',
    taxRate: n(l.taxRate) || '0',
    expectedDate: t(l.expectedDate),
  };
}

/** Soma dos totais das linhas; `null` se alguma for inválida. */
export function orderGrandTotal(lines: OrderLineForm[]): string | null {
  let sum = 0n;
  for (const l of lines) {
    const t = orderLineTotals(l.quantity, l.unitPrice, l.discountRate, l.taxRate);
    if (t === null) return null;
    sum += scaled(t.total, 2)!;
  }
  return centsText(sum);
}
