/** Férias e ausências (7.4): tipos da API, textos e regras de apresentação (a API decide sempre). */

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveType {
  id: string;
  version: number;
  code: string;
  name: string;
  category: string;
  paid: boolean;
  deductsBalance: boolean;
  counting: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  requiresDocument: boolean;
  confidential: boolean;
  maxDaysPerRequest: string | null;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface LeavePolicy {
  id: string;
  version: number;
  code: string;
  policyVersion: number;
  name: string;
  legalEntityId: string | null;
  legalEntityCode: string | null;
  calendarId: string;
  calendarCode: string;
  annualDays: string;
  firstYearRule: 'FULL' | 'PROPORTIONAL_MONTHS' | 'DAYS_PER_MONTH';
  firstYearDaysPerMonth: string | null;
  rounding: 'NONE' | 'HALF_DAY_UP' | 'DAY_UP';
  carryoverMaxDays: string;
  legalReference: string;
  validFrom: string;
  validTo: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
}

export interface Balance {
  year: number;
  accrued: string;
  carriedOver: string;
  expired: string;
  adjustments: string;
  entitled: string;
  taken: string;
  pending: string;
  balance: string;
  available: string;
}

export interface LedgerEntry {
  id: string;
  kind: 'ACCRUAL' | 'CARRYOVER' | 'EXPIRY' | 'ADJUSTMENT' | 'TAKEN' | 'REVERSAL';
  days: string;
  effectiveDate: string;
  reason: string | null;
  leaveRequestId: string | null;
  actor: string | null;
}

export interface LeaveSummary {
  employee: { id: string; code: string; fullName: string };
  balance: Balance;
  policy: LeavePolicy | null;
  ledger: LedgerEntry[];
  access: { manage: boolean; request: boolean };
}

export interface LeaveRequest {
  id: string;
  version: number;
  employee: { id: string; code: string; fullName: string };
  leaveType: { id: string | null; code: string | null; name: string; confidential: boolean };
  paid: boolean;
  deductsBalance: boolean;
  startDate: string;
  endDate: string;
  days: string;
  year: number;
  status: LeaveStatus;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  cancelReason: string | null;
  access?: { approve: boolean; cancel: boolean; documents: boolean };
  [key: string]: unknown;
}

export const LEAVE_STATUS: Record<LeaveStatus, string> = {
  PENDING: 'Pendente',
  APPROVED: 'Aprovada',
  REJECTED: 'Recusada',
  CANCELLED: 'Cancelada',
};
export const LEAVE_CATEGORY: Record<string, string> = {
  VACATION: 'Férias',
  SICK: 'Doença',
  MATERNITY: 'Maternidade',
  PATERNITY: 'Paternidade',
  BEREAVEMENT: 'Luto',
  MARRIAGE: 'Casamento',
  UNPAID: 'Sem vencimento',
  OTHER: 'Outra',
};
export const LEDGER_KIND: Record<LedgerEntry['kind'], string> = {
  ACCRUAL: 'Direito do ano',
  CARRYOVER: 'Transporte',
  EXPIRY: 'Expiração',
  ADJUSTMENT: 'Ajuste',
  TAKEN: 'Gozo',
  REVERSAL: 'Reversão',
};
export const FIRST_YEAR_RULE: Record<LeavePolicy['firstYearRule'], string> = {
  FULL: 'Direito anual completo',
  PROPORTIONAL_MONTHS: 'Proporcional aos meses completos',
  DAYS_PER_MONTH: 'Dias por mês completo',
};
export const ROUNDING: Record<LeavePolicy['rounding'], string> = {
  NONE: 'Sem arredondamento (2 casas)',
  HALF_DAY_UP: 'Meio dia acima',
  DAY_UP: 'Dia inteiro acima',
};
export const COUNTING: Record<LeaveType['counting'], string> = {
  WORKING_DAYS: 'Dias úteis (calendário da política)',
  CALENDAR_DAYS: 'Dias de calendário',
};

export function leaveTone(status: LeaveStatus | string): string {
  if (status === 'APPROVED' || status === 'ACTIVE') return 'bg-success-soft text-success-text';
  if (status === 'PENDING' || status === 'DRAFT') return 'bg-warning-soft text-warning-text';
  if (status === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

/** Dias em texto para leitura (sem zeros inúteis): "4.00" → "4", "16.50" → "16,5". */
export function daysLabel(days: string | null | undefined): string {
  if (days === null || days === undefined || days === '') return '—';
  const n = days.replace(/\.?0+$/, '');
  return (n === '' || n === '-' ? '0' : n).replace('.', ',');
}

/** O pedido caberia no saldo disponível? (comparação em cêntimos; o servidor decide). */
export function fitsBalance(days: string, available: string): boolean {
  const c = (v: string) => {
    const neg = v.startsWith('-');
    const [i, f = ''] = v.replace('-', '').split('.');
    const x = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
    return neg ? -x : x;
  };
  return c(days) <= c(available);
}
