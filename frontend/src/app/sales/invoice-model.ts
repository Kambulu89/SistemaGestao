/** Facturas de venda (10.6): tipos, rótulos e conversões. Emissão demonstrativa (séries em simulação). */

export interface InvoiceRow {
  id: string;
  number: string | null;
  customer: { code: string; name: string };
  legalEntity: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  payableTotal: string;
  paidTotal: string;
  openTotal: string | null;
  status: string;
  fiscalStatus: string | null;
  collectionStatus: string | null;
}

export interface InvoiceTax {
  codeId: string;
  code: string;
  kind: string;
  rate: string;
  exemptionCode: string | null;
  base: string;
  amount: string;
}

export interface InvoiceLine {
  id: string;
  lineNo: number;
  product: { id: string; sku: string };
  description: string;
  quantity: string;
  uom: string;
  manualDiscountPct: string | null;
  manualUnitPrice: string | null;
  priceSource: string;
  basePrice: string | null;
  netUnitPrice: string | null;
  discountPct: string;
  netAmount: string;
  taxCodeIds: string[];
  exemptionCode: string | null;
  taxAmount: string;
  taxes: InvoiceTax[];
  orderLineId: string | null;
}

export interface Invoice {
  id: string;
  version: number;
  number: string | null;
  status: string;
  fiscalStatus: string | null;
  collectionStatus: string | null;
  documentKind: 'INVOICE' | 'INVOICE_RECEIPT';
  simulation: boolean;
  payments: {
    receiptId: string;
    number: string | null;
    date: string;
    amount: string;
    kind: string;
  }[];
  legalEntity: { id: string; code: string; name: string; taxId: string | null };
  branch: { id: string; code: string; name: string } | null;
  customer: { id: string; code: string; name: string; status: string };
  customerSnapshot: {
    name: string;
    taxId: string | null;
    countryCode: string;
    billingAddress: { addressLine: string | null; city: string | null; countryCode: string };
  } | null;
  order: { id: string; number: string } | null;
  series: { id: string; code: string; fiscalCode: string } | null;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  functionalCurrency: string | null;
  exchangeRate: string | null;
  paymentTermsDays: number;
  customerReference: string | null;
  notes: string | null;
  roundingLevel: string | null;
  netTotal: string;
  taxTotal: string;
  grossTotal: string;
  withholdingTotal: string;
  payableTotal: string;
  paidTotal: string;
  creditedTotal: string;
  debitedTotal: string;
  openTotal: string | null;
  correctionNotes: {
    id: string;
    kind: 'CREDIT' | 'DEBIT';
    number: string | null;
    status: string;
    date: string;
    payable: string;
    reasonCode: string;
  }[];
  taxSummary: {
    summary: (InvoiceTax & { applied: boolean })[];
    ratesUsed: { code: string; rate: string; legalSource: string }[];
  } | null;
  documentHash: string | null;
  issuedAt: string | null;
  issuedBy: string | null;
  discardReason: string | null;
  lines: InvoiceLine[];
  history: {
    kind: string;
    reason: string | null;
    details: Record<string, unknown> | null;
    at: string;
    by: string | null;
  }[];
  can: { edit: boolean; issue: boolean; discard: boolean };
}

export interface InvoiceOptions {
  legalEntities: { id: string; code: string; name: string; countryCode: string }[];
  branches: { id: string; code: string; name: string; legalEntityId: string }[];
  series: {
    id: string;
    code: string;
    prefix: string;
    legalEntityId: string;
    fiscalYear: number;
    mode: string;
  }[];
  taxCodes: { id: string; code: string; name: string; kind: string; countryCode: string }[];
  exemptions: { code: string; description: string; countryCode: string }[];
}

export const INVOICE_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho',
  ISSUED: 'Emitida',
  CORRECTED: 'Corrigida',
  DISCARDED: 'Descartada',
};
export const FISCAL_STATE: Record<string, string> = {
  PENDING: 'Fiscal: pendente',
  ACCEPTED: 'Fiscal: aceite',
  REJECTED: 'Fiscal: rejeitada',
  CONTINGENCY: 'Fiscal: contingência',
};
export const COLLECTION_STATE: Record<string, string> = {
  UNPAID: 'Por pagar',
  PARTIAL: 'Paga em parte',
  PAID: 'Paga',
  OVERDUE: 'Vencida',
};
export const INVOICE_EVENT: Record<string, string> = {
  CREATED: 'Criada',
  CREATED_FROM_ORDER: 'Criada a partir da encomenda',
  ISSUED: 'Emitida',
  DISCARDED: 'Descartada',
  PAYMENT: 'Pagamento recebido',
  CREDITED: 'Nota de crédito emitida',
  DEBITED: 'Nota de débito emitida',
};

export function invoiceTone(s: string | null): string {
  if (s === 'ISSUED' || s === 'PAID' || s === 'ACCEPTED')
    return 'bg-success-soft text-success-text';
  if (s === 'PENDING' || s === 'PARTIAL' || s === 'UNPAID' || s === 'CONTINGENCY')
    return 'bg-warning-soft text-warning-text';
  if (s === 'OVERDUE' || s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

export interface InvoiceLineForm {
  key: number;
  productId: string;
  productLabel: string;
  description: string;
  quantity: string;
  manualDiscountPct: string;
  manualUnitPrice: string;
  taxCodes: Record<string, boolean>;
  exemptionCode: string;
  orderLineId?: string | null;
}

let seq = 0;
export function emptyInvoiceLine(): InvoiceLineForm {
  return {
    key: ++seq,
    productId: '',
    productLabel: '',
    description: '',
    quantity: '1',
    manualDiscountPct: '',
    manualUnitPrice: '',
    taxCodes: {},
    exemptionCode: '',
  };
}

const nz = (v: string) => (v.trim() === '' ? null : v.trim());
const dec = (v: string) => nz(v)?.replace(',', '.') ?? null;
export const selectedCodes = (m: Record<string, boolean>) =>
  Object.entries(m)
    .filter(([, on]) => on)
    .map(([id]) => id);

export function invoiceLinesPayload(lines: InvoiceLineForm[]) {
  return lines.map((l) => ({
    productId: l.productId,
    description: nz(l.description),
    quantity: l.quantity.trim().replace(',', '.'),
    manualDiscountPct: dec(l.manualDiscountPct),
    manualUnitPrice: dec(l.manualUnitPrice),
    taxCodeIds: selectedCodes(l.taxCodes),
    exemptionCode: nz(l.exemptionCode),
  }));
}
