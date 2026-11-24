/** Recebimentos, factura-recibo e adiantamentos (10.7): tipos, rótulos e conversões. */

export interface ReceiptRow {
  id: string;
  number: string | null;
  purpose: 'RECEIPT' | 'INVOICE_RECEIPT';
  customer: { code: string; name: string };
  receivedDate: string;
  currency: string;
  amount: string;
  method: string;
  reference: string | null;
  advanceRemaining: string;
  status: string;
}

export interface Receipt {
  id: string;
  version: number;
  number: string | null;
  purpose: 'RECEIPT' | 'INVOICE_RECEIPT';
  status: string;
  legalEntity: { id: string; code: string };
  customer: { id: string; code: string; name: string };
  invoice: { id: string; number: string | null; status: string } | null;
  currency: string;
  amount: string;
  method: string;
  bankAccount: { id: string; label: string } | null;
  reference: string | null;
  receivedDate: string;
  notes: string | null;
  allocatedTotal: string;
  advanceTotal: string;
  advanceUsed: string;
  advanceRemaining: string;
  registeredBy: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  decisionReason: string | null;
  allocations: { invoiceId: string; number: string; amount: string }[];
  applications: {
    invoiceId: string;
    number: string;
    amount: string;
    at: string;
    by: string | null;
  }[];
  can: { confirm: boolean; reject: boolean; cancel: boolean; applyAdvance: boolean };
}

export interface OpenItems {
  invoices: {
    id: string;
    number: string;
    invoiceDate: string;
    dueDate: string;
    currency: string;
    open: string;
  }[];
  invoiceReceiptDrafts: { id: string; invoiceDate: string; currency: string; payable: string }[];
  advances: { id: string; number: string; currency: string; remaining: string }[];
}

export interface ReceiptOptions {
  legalEntities: { id: string; code: string; name: string }[];
  bankAccounts: { id: string; legalEntityId: string; label: string; currency: string }[];
  series: {
    id: string;
    code: string;
    prefix: string;
    legalEntityId: string;
    fiscalYear: number;
    documentKind: string;
  }[];
}

export const RECEIPT_STATUS: Record<string, string> = {
  PENDING: 'Por confirmar',
  CONFIRMED: 'Confirmado',
  REJECTED: 'Recusado',
  CANCELLED: 'Anulado',
};
export const METHOD: Record<string, string> = {
  CASH: 'Numerário',
  TRANSFER: 'Transferência',
  CARD: 'Cartão',
  CHEQUE: 'Cheque',
  OTHER: 'Outro',
};
export const PURPOSE: Record<string, string> = {
  RECEIPT: 'Recibo (facturas emitidas ou adiantamento)',
  INVOICE_RECEIPT: 'Factura-recibo (emite-se na confirmação)',
};

export function receiptTone(s: string): string {
  if (s === 'CONFIRMED') return 'bg-success-soft text-success-text';
  if (s === 'PENDING') return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

/** Soma exacta de valores com 2 casas (texto), sem float. */
export function sumAmounts(values: string[]): string {
  const cents = values.reduce((a, v) => {
    const t = v.trim().replace(',', '.');
    if (!/^\d+(\.\d{0,2})?$/.test(t)) return a;
    const [i, f = ''] = t.split('.');
    return a + BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
  }, 0n);
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Diferença a − b (2 casas), sem float. */
export function minusAmount(a: string, b: string): string {
  const c = (v: string) => {
    const [i, f = ''] = sumAmounts([v]).split('.');
    return BigInt(i) * 100n + BigInt(f);
  };
  const d = c(a) - c(b);
  const neg = d < 0n;
  const abs = neg ? -d : d;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
