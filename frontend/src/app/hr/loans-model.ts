/** Adiantamentos e empréstimos (7.6): tipos da API, textos e apresentação (a API decide sempre). */

export type LoanKind = 'ADVANCE' | 'LOAN';
export type LoanStatus =
  'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'SETTLED' | 'REJECTED' | 'CANCELLED';
export type InstallmentStatus = 'PLANNED' | 'PENDING' | 'DEDUCTED' | 'PAID' | 'CANCELLED';

export interface Installment {
  id: string | null;
  sequence: number;
  duePeriod: string;
  amount: string;
  status: InstallmentStatus;
  settlementReference: string | null;
  settledOn: string | null;
  settlementNote: string | null;
}

export interface Loan {
  id: string;
  version: number;
  code: string;
  employee: { id: string; code: string; fullName: string };
  kind: LoanKind;
  currency: string;
  principal: string;
  installmentsCount: number;
  firstPeriod: string;
  reason: string;
  status: LoanStatus;
  paidAmount: string;
  outstandingAmount: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  createdBy: string | null;
  installments?: Installment[];
  limits?: {
    maxInstallmentPercent: string | null;
    maxInstallments: number | null;
    policyReference: string | null;
  };
  issues?: { path: string; code: string; message: string }[];
  access?: { manage: boolean; approve: boolean };
  [key: string]: unknown;
}

export interface EmployeeLoans {
  employee: { id: string; code: string; fullName: string };
  items: Loan[];
  outstanding: string | null;
  access: { manage: boolean; approve: boolean };
}

export const LOAN_KIND: Record<LoanKind, string> = {
  ADVANCE: 'Adiantamento',
  LOAN: 'Empréstimo',
};
export const LOAN_STATUS: Record<LoanStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Aguarda aprovação',
  ACTIVE: 'Activo',
  SETTLED: 'Liquidado',
  REJECTED: 'Recusado',
  CANCELLED: 'Cancelado',
};
export const INSTALLMENT_STATUS: Record<InstallmentStatus, string> = {
  PLANNED: 'Prevista',
  PENDING: 'Por descontar',
  DEDUCTED: 'Descontada',
  PAID: 'Paga',
  CANCELLED: 'Cancelada',
};

export function loanTone(s: LoanStatus): string {
  if (s === 'ACTIVE') return 'bg-info-soft text-info-text';
  if (s === 'SETTLED') return 'bg-success-soft text-success-text';
  if (s === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

export function installmentTone(s: InstallmentStatus): string {
  if (s === 'DEDUCTED' || s === 'PAID') return 'bg-success-soft text-success-text';
  if (s === 'PENDING') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/** "2026-11-01" → "novembro de 2026". */
export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  if (!m) return period;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} de ${m[1]}`;
}

/**
 * Prestação mensal prevista (texto decimal), como o servidor a calcula: partes iguais ao cêntimo e o resto na
 * última. Devolve `{ regular, last }` ou `null` se os dados ainda não chegam. Só para mostrar; a API recalcula.
 */
export function installmentPreview(principal: string | null, count: number | null) {
  if (!principal || !count || count < 1 || !/^\d+(\.\d{1,2})?$/.test(principal)) return null;
  const [int, frac = ''] = principal.split('.');
  const total = BigInt(int) * 100n + BigInt(frac.padEnd(2, '0'));
  const n = BigInt(count);
  if (total < n) return null;
  const base = total / n;
  const text = (c: bigint) => {
    const s = c.toString().padStart(3, '0');
    return `${s.slice(0, -2)}.${s.slice(-2)}`;
  };
  return { regular: text(base), last: text(base + (total - base * n)) };
}

/** Percentagem já liquidada (0–100, inteiro), para a barra de progresso. */
export function settledPercent(loan: Pick<Loan, 'principal' | 'paidAmount'>): number {
  const p = Number(loan.principal);
  if (!p) return 0;
  return Math.min(100, Math.floor((Number(loan.paidAmount) / p) * 100));
}
