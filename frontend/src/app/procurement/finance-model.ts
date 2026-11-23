/** Compras ↔ orçamento, obrigações a pagar e contabilidade (9.10): tipos da API, rótulos e cores. */
export type BudgetControl = 'BLOCK' | 'WARN';
export type PayableStatus = 'OPEN' | 'PARTIALLY_PAID' | 'SETTLED';
export type AccountingStatus = 'PENDING' | 'POSTED' | 'DRAFTED' | 'FAILED';

export interface Budget {
  id: string;
  version: number;
  legalEntity: { id: string; code: string };
  costCenter: { id: string; code: string; name: string };
  fiscalYear: number;
  amount: string;
  control: BudgetControl;
  notes: string | null;
  committedRequisitions: string;
  committedOrders: string;
  actual: string;
  available: string;
  over: boolean;
  canManage: boolean;
}

export interface BudgetMovements {
  budget: Budget;
  documents: {
    kind: 'COMMITMENT' | 'ACTUAL';
    sourceType: 'REQUISITION' | 'ORDER' | 'INVOICE' | 'CREDIT_NOTE';
    sourceId: string;
    sourceRef: string | null;
    amount: string;
  }[];
}

export interface PayableRow {
  id: string;
  status: PayableStatus;
  supplier: { id: string; code: string; name: string };
  invoice: { id: string; number: string; invoiceNumber: string };
  currency: string;
  amount: string;
  balance: string;
  dueDate: string;
  overdue: boolean;
}

export interface AccountingEvent {
  id: string;
  documentType: 'INVOICE' | 'CREDIT_NOTE' | 'PAYMENT';
  documentId: string;
  event: string;
  sourceRef: string;
  occurredOn: string;
  total: string;
  amounts: Record<string, string>;
  status: AccountingStatus;
  error: string | null;
  attempts: number;
  entryNumber: string | null;
}

export interface Payable {
  id: string;
  version: number;
  status: PayableStatus;
  legalEntity: { id: string; code: string };
  supplier: { id: string; code: string; name: string };
  order: { id: string; number: string };
  invoice: { id: string; number: string; invoiceNumber: string; invoiceDate: string };
  costCenter: { id: string; code: string } | null;
  currency: string;
  exchangeRate: string;
  amount: string;
  creditedAmount: string;
  paidAmount: string;
  balance: string;
  dueDate: string;
  overdue: boolean;
  payments: {
    id: string;
    paidOn: string;
    amount: string;
    exchangeRate: string;
    amountFunctional: string;
    reference: string;
    notes: string | null;
    bank: string | null;
    by: string | null;
  }[];
  bankAccounts: { id: string; label: string }[];
  accounting: AccountingEvent[];
  can: { pay: boolean; retry: boolean };
}

export const BUDGET_CONTROL: Record<BudgetControl, string> = {
  BLOCK: 'Bloqueia o excesso',
  WARN: 'Só avisa',
};
export const PAYABLE_STATUS: Record<PayableStatus, string> = {
  OPEN: 'Por pagar',
  PARTIALLY_PAID: 'Paga em parte',
  SETTLED: 'Saldada',
};
export const ACCOUNTING_STATUS: Record<AccountingStatus, string> = {
  PENDING: 'Por enviar',
  POSTED: 'Lançado',
  DRAFTED: 'Rascunho no razão',
  FAILED: 'Falhado',
};
export const ACCOUNTING_DOCUMENT: Record<AccountingEvent['documentType'], string> = {
  INVOICE: 'Factura',
  CREDIT_NOTE: 'Nota de crédito',
  PAYMENT: 'Pagamento',
};
export const COMMITMENT_SOURCE: Record<BudgetMovements['documents'][number]['sourceType'], string> =
  {
    REQUISITION: 'Requisição',
    ORDER: 'Ordem',
    INVOICE: 'Factura',
    CREDIT_NOTE: 'Nota de crédito',
  };
/** Montantes do evento com nome legível (as chaves que as regras de contabilização usam). */
export const AMOUNT_LABEL: Record<string, string> = {
  goodsReceived: 'Recepções por facturar',
  priceVarianceUp: 'Diferença de preço (a mais)',
  priceVarianceDown: 'Diferença de preço (a menos)',
  services: 'Serviços e encargos',
  tax: 'Imposto',
  payable: 'Fornecedor',
  bank: 'Banco',
  fxLoss: 'Perda cambial',
  fxGain: 'Ganho cambial',
};

export function payableTone(s: PayableStatus, overdue = false): string {
  if (s === 'SETTLED') return 'bg-success-soft text-success-text';
  if (overdue) return 'bg-danger-soft text-danger-text';
  return s === 'PARTIALLY_PAID' ? 'bg-warning-soft text-warning-text' : 'bg-surface-2 text-muted';
}
export function accountingTone(s: AccountingStatus): string {
  if (s === 'POSTED') return 'bg-success-soft text-success-text';
  if (s === 'FAILED') return 'bg-danger-soft text-danger-text';
  return 'bg-warning-soft text-warning-text';
}

/** Montantes diferentes de zero, por ordem das chaves conhecidas. */
export function nonZeroAmounts(
  amounts: Record<string, string>,
): { label: string; value: string }[] {
  return Object.keys(AMOUNT_LABEL)
    .filter((k) => amounts[k] !== undefined && !/^-?0+(\.0+)?$/.test(amounts[k]))
    .map((k) => ({ label: AMOUNT_LABEL[k], value: amounts[k] }));
}

/** Percentagem usada da verba (comprometido + realizado), para a barra; limitada a 0–100. */
export function usedPercent(b: Pick<Budget, 'amount' | 'available'>): number {
  const amount = Number(b.amount);
  if (!(amount > 0)) return 100;
  const used = amount - Number(b.available);
  return Math.max(0, Math.min(100, Math.round((used / amount) * 100)));
}
