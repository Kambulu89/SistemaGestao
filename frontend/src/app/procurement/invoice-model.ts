/** Facturas de fornecedor (9.8): tipos da API, rótulos, cores e formulário (valores como no servidor). */
import { orderLineTotals } from './order-model';
import { scaled } from './requisition-model';
import { plain } from './rfq-model';

export type InvoiceStatus = 'DRAFT' | 'PENDING_EXCEPTION' | 'VALIDATED' | 'REJECTED' | 'CANCELLED';
export type DivergenceCode =
  'QTY_OVER_RECEIVED' | 'PRICE_OVER_ORDER' | 'TAX_MISMATCH' | 'UNMATCHED_LINE' | 'TOTAL_MISMATCH';

export interface Divergence {
  code: DivergenceCode;
  lineNo: number | null;
  message: string;
  details: Record<string, string>;
}

export interface InvoiceRow {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  supplier: { id: string; code: string; name: string };
  order: { id: string; number: string };
  currency: string;
  totalAmount: string;
  divergences: number;
}

export interface InvoiceLine {
  id: string;
  lineNo: number;
  orderLineId: string | null;
  orderLineNo: number | null;
  description: string;
  uom: string | null;
  quantity: string;
  unitPrice: string;
  discountRate: string;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  totalAmount: string;
  credited: { quantity: string; total: string } | null;
  match: {
    ordered: string | null;
    received: string | null;
    invoicedBefore: string | null;
    orderNet: string | null;
    orderTaxRate: string | null;
    codes: DivergenceCode[];
  } | null;
}

export interface Invoice {
  id: string;
  version: number;
  number: string | null;
  status: InvoiceStatus;
  legalEntity: { id: string; code: string };
  supplier: { id: string; code: string; name: string };
  order: { id: string; number: string };
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  declaredTotal: string;
  totalNet: string;
  totalTax: string;
  totalAmount: string;
  exchangeRate: string | null;
  totalFunctional: string | null;
  notes: string | null;
  divergences: Divergence[];
  submittedAt: string | null;
  submittedBy: string | null;
  validatedAt: string | null;
  validatedBy: string | null;
  rejectReason: string | null;
  cancelReason: string | null;
  lines: InvoiceLine[];
  creditedTotal: string;
  balance: string;
  creditNotes: {
    id: string;
    number: string | null;
    creditNoteNumber: string;
    status: 'DRAFT' | 'VALIDATED' | 'CANCELLED';
    creditNoteDate: string;
    totalAmount: string;
  }[];
  exceptions: {
    decision: 'APPROVE' | 'REJECT';
    reason: string;
    divergences: Divergence[];
    requestedBy: string | null;
    decidedBy: string | null;
    at: string;
  }[];
  history: { kind: string; reason: string | null; at: string; by: string | null }[];
  can: {
    edit: boolean;
    validate: boolean;
    decide: boolean;
    decideBlockedBy: string | null;
    refuse: boolean;
    cancel: boolean;
    credit: boolean;
  };
}

export interface InvoiceableOrder {
  id: string;
  number: string;
  invoiceable: boolean;
  supplier: { id: string; code: string; name: string };
  currency: string;
  paymentTermsDays: number | null;
  lines: {
    id: string;
    lineNo: number;
    description: string;
    uom: string | null;
    ordered: string;
    received: string;
    invoiced: string;
    toInvoice: string;
    unitPrice: string;
    discountRate: string;
    taxRate: string;
  }[];
}

export interface Tolerances {
  pricePct: string;
  priceAmount: string;
  qtyPct: string;
  totalAmount: string;
}

export const INVOICE_STATUS: Record<InvoiceStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_EXCEPTION: 'Excepção pendente',
  VALIDATED: 'Validada',
  REJECTED: 'Devolvida',
  CANCELLED: 'Anulada',
};
export const DIVERGENCE: Record<DivergenceCode, string> = {
  QTY_OVER_RECEIVED: 'Acima do recebido',
  PRICE_OVER_ORDER: 'Preço acima da ordem',
  TAX_MISMATCH: 'Imposto diferente',
  UNMATCHED_LINE: 'Encargo fora da ordem',
  TOTAL_MISMATCH: 'Total diferente',
};
export const INVOICE_EVENT: Record<string, string> = {
  CREATED: 'Registada',
  UPDATED: 'Alterada',
  DIVERGENT: 'Conferência com divergências',
  VALIDATED: 'Validada',
  EXCEPTION_APPROVED: 'Excepção autorizada',
  EXCEPTION_REJECTED: 'Excepção recusada',
  REJECTED: 'Devolvida ao fornecedor',
  CANCELLED: 'Anulada',
};

export function invoiceTone(s: InvoiceStatus): string {
  if (s === 'VALIDATED') return 'bg-success-soft text-success-text';
  if (s === 'PENDING_EXCEPTION') return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

export interface InvoiceLineForm {
  orderLineId: string | null;
  label: string;
  uom: string | null;
  toInvoice: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discountRate: string;
  taxRate: string;
}

/** Linhas da ordem com o que falta facturar (por omissão, a quantidade e o preço da ordem); as já facturadas ficam vazias. */
export function invoiceForm(o: InvoiceableOrder): InvoiceLineForm[] {
  return o.lines.map((l) => {
    const pending = !/^0(\.0+)?$/.test(l.toInvoice);
    return {
      orderLineId: l.id,
      label: `${l.lineNo} · ${l.description}`,
      uom: l.uom,
      toInvoice: l.toInvoice,
      description: '',
      quantity: pending ? plain(l.toInvoice) : '',
      unitPrice: plain(l.unitPrice),
      discountRate: plain(l.discountRate),
      taxRate: plain(l.taxRate),
    };
  });
}
export const chargeLine = (): InvoiceLineForm => ({
  orderLineId: null,
  label: 'Encargo',
  uom: null,
  toInvoice: null,
  description: '',
  quantity: '1',
  unitPrice: '',
  discountRate: '',
  taxRate: '',
});

const filled = (l: InvoiceLineForm) =>
  l.quantity.trim() !== '' && !/^0+([.,]0+)?$/.test(l.quantity.trim());

export function invoicePayload(lines: InvoiceLineForm[]) {
  const n = (v: string) => v.trim().replace(',', '.');
  return lines.filter(filled).map((l) => ({
    orderLineId: l.orderLineId,
    description: l.description.trim() || undefined,
    quantity: n(l.quantity),
    unitPrice: n(l.unitPrice),
    discountRate: n(l.discountRate) || '0',
    taxRate: n(l.taxRate) || '0',
  }));
}

/** Soma das linhas (com imposto), como no servidor; `null` se alguma for inválida. */
export function invoiceTotal(lines: InvoiceLineForm[]): string | null {
  let sum = 0n;
  for (const l of lines.filter(filled)) {
    const t = orderLineTotals(l.quantity, l.unitPrice, l.discountRate, l.taxRate);
    if (t === null) return null;
    sum += scaled(t.total, 2)!;
  }
  return `${sum / 100n}.${(sum % 100n).toString().padStart(2, '0')}`;
}

/** Diferença (com sinal) entre o total declarado e a soma das linhas; `null` se algum for inválido. */
export function declaredDifference(declared: string, computed: string | null): string | null {
  const d = scaled(declared.replace(',', '.'), 2);
  const c = computed === null ? null : scaled(computed, 2);
  if (d === null || c === null) return null;
  const x = d - c;
  const a = x < 0n ? -x : x;
  return `${x < 0n ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}
