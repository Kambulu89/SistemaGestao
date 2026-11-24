/** Notas de crédito e débito e reembolsos (10.8): tipos, rótulos e conversões. Emissão demonstrativa (simulação). */

export interface NoteRow {
  id: string;
  kind: 'CREDIT' | 'DEBIT';
  number: string | null;
  invoiceNumber: string;
  customer: { code: string; name: string };
  noteDate: string;
  reasonCode: string;
  currency: string;
  payableTotal: string;
  availableCredit: string | null;
  status: string;
}

export interface NoteTax {
  codeId: string;
  code: string;
  kind: string;
  rate: string;
  exemptionCode: string | null;
  base: string;
  amount: string;
}

export interface Refund {
  id: string;
  version: number;
  amount: string;
  method: string;
  bankAccount: string | null;
  reference: string | null;
  refundDate: string;
  status: string;
  registeredBy: string | null;
  confirmedBy: string | null;
  decisionReason: string | null;
  can: { confirm: boolean; reject: boolean; cancel: boolean };
}

export interface Note {
  id: string;
  version: number;
  kind: 'CREDIT' | 'DEBIT';
  number: string | null;
  status: string;
  fiscalStatus: string | null;
  simulation: boolean;
  legalEntity: { id: string; code: string; name: string };
  customer: { id: string; code: string; name: string };
  customerSnapshot: { name?: string; taxId?: string | null } | null;
  invoice: { id: string; number: string; date: string };
  order: { id: string; number: string } | null;
  returnDoc: { id: string; reference: string } | null;
  series: { id: string; code: string } | null;
  reasonCode: string;
  reason: string;
  noteDate: string;
  currency: string;
  exchangeRate: string;
  netTotal: string;
  taxTotal: string;
  grossTotal: string;
  withholdingTotal: string;
  payableTotal: string;
  taxSummary: (NoteTax & { applied: boolean })[];
  appliedTotal: string;
  refundedTotal: string;
  pendingRefunds: string;
  availableCredit: string;
  documentHash: string | null;
  createdBy: string | null;
  issuedBy: string | null;
  issuedAt: string | null;
  discardReason: string | null;
  lines: {
    id: string;
    lineNo: number;
    invoiceLineId: string;
    invoiceLineNo: number;
    sku: string;
    description: string;
    mode: 'QUANTITY' | 'VALUE';
    quantity: string | null;
    uom: string;
    netAmount: string;
    taxAmount: string;
    taxes: NoteTax[];
  }[];
  applications: {
    invoiceId: string;
    number: string;
    amount: string;
    at: string;
    by: string | null;
  }[];
  refunds: Refund[];
  openInvoices: { id: string; number: string; open: string }[];
  can: { edit: boolean; issue: boolean; discard: boolean; applyCredit: boolean; refund: boolean };
}

export interface Eligible {
  invoice: {
    id: string;
    number: string;
    legalEntityId: string;
    invoiceDate: string;
    currency: string;
    payableTotal: string;
    openTotal: string;
    creditedTotal: string;
    debitedTotal: string;
  };
  lines: {
    id: string;
    lineNo: number;
    sku: string;
    description: string;
    uom: string;
    quantity: string;
    netUnitPrice: string;
    netAmount: string;
    creditedQty: string;
    creditedNet: string;
    remainingQty: string;
    remainingNet: string;
    taxes: { code: string; rate: string; kind: string }[];
  }[];
  returns: { id: string; reference: string; date: string }[];
}

export interface NoteOptions {
  series: {
    id: string;
    code: string;
    prefix: string;
    legalEntityId: string;
    fiscalYear: number;
    documentKind: string;
  }[];
  bankAccounts: { id: string; legalEntityId: string; label: string; currency: string }[];
}

export const NOTE_KIND: Record<string, string> = {
  CREDIT: 'Nota de crédito',
  DEBIT: 'Nota de débito',
};
export const NOTE_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho',
  ISSUED: 'Emitida',
  DISCARDED: 'Descartada',
};
export const NOTE_REASON: Record<string, string> = {
  RETURN: 'Devolução de mercadoria',
  PRICE_CORRECTION: 'Correcção de preço',
  DISCOUNT: 'Desconto concedido',
  DAMAGE: 'Avaria ou serviço não conforme',
  CANCELLATION: 'Anulação de venda',
  ADDITIONAL_CHARGE: 'Encargo adicional',
  INTEREST: 'Juros ou penalização',
  OTHER: 'Outro',
};
export const NOTE_REASONS: Record<'CREDIT' | 'DEBIT', string[]> = {
  CREDIT: ['RETURN', 'PRICE_CORRECTION', 'DISCOUNT', 'DAMAGE', 'CANCELLATION', 'OTHER'],
  DEBIT: ['PRICE_CORRECTION', 'ADDITIONAL_CHARGE', 'INTEREST', 'OTHER'],
};
export const REFUND_STATUS: Record<string, string> = {
  PENDING: 'Por confirmar',
  CONFIRMED: 'Pago',
  REJECTED: 'Recusado',
  CANCELLED: 'Anulado',
};

export function noteTone(s: string | null): string {
  if (s === 'ISSUED' || s === 'CONFIRMED') return 'bg-success-soft text-success-text';
  if (s === 'DRAFT' || s === 'PENDING') return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

/** Texto decimal → string normalizada para a API (vírgula → ponto); vazio ou zero → null. */
export function amountOrNull(v: string): string | null {
  const t = v.trim().replace(',', '.');
  if (!t || /^0+(\.0*)?$/.test(t)) return null;
  return t;
}
