/** Cessação (7.11): tipos, rótulos e cálculos de apoio (sem `float`; a API valida e decide). */

export type TerminationStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SETTLED' | 'CANCELLED';
export type TerminationReason =
  | 'RESIGNATION'
  | 'MUTUAL_AGREEMENT'
  | 'DISMISSAL_DISCIPLINARY'
  | 'DISMISSAL_OBJECTIVE'
  | 'END_OF_TERM'
  | 'PROBATION'
  | 'RETIREMENT'
  | 'DEATH'
  | 'OTHER';
export type SettlementKind =
  | 'UNUSED_VACATION'
  | 'PROPORTIONAL_VACATION'
  | 'PROPORTIONAL_ALLOWANCE'
  | 'NOTICE_PAY'
  | 'INDEMNITY'
  | 'OTHER_EARNING'
  | 'NOTICE_DEDUCTION'
  | 'OTHER_DEDUCTION';
export type TaskStatus = 'PENDING' | 'DONE' | 'NOT_APPLICABLE';

export interface SettlementLine {
  id: string;
  kind: SettlementKind;
  component: { id: string; code: string; name: string; kind: 'EARNING' | 'DEDUCTION' };
  description: string;
  quantity: string | null;
  rate: string | null;
  amount: string;
  basis: string;
}

export interface TerminationTask {
  id: string;
  version: number;
  category: 'ACCESS' | 'EQUIPMENT' | 'DOCUMENTS' | 'FINANCE' | 'OTHER';
  kind: 'MANUAL' | 'SYSTEM_ACCESS' | 'LOANS' | 'RETURN_ITEM';
  title: string;
  status: TaskStatus;
  notes: string | null;
  completedBy: string | null;
  completedAt: string | null;
}

export interface TerminationFacts {
  hireDate: string;
  contract: { baseSalary: string | null; currency: string; status: string } | null;
  service: { years: number; months: number; days: number; totalDays: number };
  notice: { required: number | null; given: number | null; shortfall: number | null };
  vacation: {
    year: number;
    accrued: string;
    carriedOver: string;
    entitled: string;
    taken: string;
    pending: string;
    balance: string;
    daysWorkedInYear: number;
    daysInYear: number;
    proportionalHint: string;
  };
  pendingPay: {
    period: string;
    regularRun: { code: string; status: string } | null;
    runs: { id: string; code: string; kind: string; status: string; period: string }[];
  };
  loans: { id: string; code: string; kind: string; status: string; outstanding: string }[];
  directReports: number;
}

export interface Termination {
  id: string;
  version: number;
  code: string;
  employee: { id: string; code: string; fullName: string; status: string };
  contract: { id: string; code: string };
  reason: TerminationReason;
  initiative: 'EMPLOYEE' | 'EMPLOYER' | 'MUTUAL' | 'OTHER';
  details: string;
  disciplinaryCase: { id: string; code: string } | null;
  noticeGivenOn: string | null;
  lastWorkingDay: string;
  noticeRequiredDays: number | null;
  noticeBasis: string | null;
  indemnityApplicable: boolean;
  indemnityBasis: string | null;
  currency: string;
  status: TerminationStatus;
  createdBy: string | null;
  createdAt: string;
  submittedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  settlementRun: { id: string; code: string; status: string } | null;
  settledAt: string | null;
  cancelReason: string | null;
  lines?: SettlementLine[];
  totals?: { earnings: string; deductions: string; net: string };
  tasks?: TerminationTask[];
  facts?: TerminationFacts;
  blockers?: { path: string; code: string; message: string }[];
  access?: { manage: boolean; edit: boolean; approve: boolean; settle: boolean };
}

export const TERMINATION_STATUS: Record<TerminationStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Por aprovar',
  APPROVED: 'Aprovada',
  SETTLED: 'Concluída',
  CANCELLED: 'Cancelada',
};

export const TERMINATION_REASON: Record<TerminationReason, string> = {
  RESIGNATION: 'Denúncia pelo trabalhador',
  MUTUAL_AGREEMENT: 'Acordo entre as partes',
  DISMISSAL_DISCIPLINARY: 'Despedimento disciplinar',
  DISMISSAL_OBJECTIVE: 'Despedimento por causas objectivas',
  END_OF_TERM: 'Caducidade (fim do termo)',
  PROBATION: 'Denúncia no período experimental',
  RETIREMENT: 'Reforma',
  DEATH: 'Falecimento',
  OTHER: 'Outro motivo',
};

export const INITIATIVE: Record<Termination['initiative'], string> = {
  EMPLOYEE: 'Do trabalhador',
  EMPLOYER: 'Da empresa',
  MUTUAL: 'Por acordo',
  OTHER: 'Outra',
};

export const SETTLEMENT_KIND: Record<SettlementKind, string> = {
  UNUSED_VACATION: 'Férias vencidas não gozadas',
  PROPORTIONAL_VACATION: 'Férias proporcionais',
  PROPORTIONAL_ALLOWANCE: 'Subsídios proporcionais',
  NOTICE_PAY: 'Compensação por falta de aviso (empresa)',
  INDEMNITY: 'Indemnização',
  OTHER_EARNING: 'Outro abono',
  NOTICE_DEDUCTION: 'Desconto por falta de aviso (trabalhador)',
  OTHER_DEDUCTION: 'Outro desconto',
};

export const TASK_CATEGORY: Record<TerminationTask['category'], string> = {
  ACCESS: 'Acessos',
  EQUIPMENT: 'Equipamentos',
  DOCUMENTS: 'Documentos',
  FINANCE: 'Finanças',
  OTHER: 'Outros',
};

export const TASK_STATUS: Record<TaskStatus, string> = {
  PENDING: 'Pendente',
  DONE: 'Feito',
  NOT_APPLICABLE: 'Não se aplica',
};

const EARNINGS: SettlementKind[] = [
  'UNUSED_VACATION',
  'PROPORTIONAL_VACATION',
  'PROPORTIONAL_ALLOWANCE',
  'NOTICE_PAY',
  'INDEMNITY',
  'OTHER_EARNING',
];

export function isEarning(kind: SettlementKind): boolean {
  return EARNINGS.includes(kind);
}

export function terminationTone(s: TerminationStatus): string {
  if (s === 'SETTLED') return 'bg-success-soft text-success-text';
  if (s === 'APPROVED') return 'bg-info-soft text-info-text';
  if (s === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  return 'bg-surface-2 text-muted';
}

export function taskTone(s: TaskStatus): string {
  if (s === 'DONE') return 'bg-success-soft text-success-text';
  if (s === 'NOT_APPLICABLE') return 'bg-surface-2 text-muted';
  return 'bg-warning-soft text-warning-text';
}

/** Decimal com até `scale` casas → inteiro escalado (`null` se inválido). */
export function scaled(raw: string | null | undefined, scale: number): bigint | null {
  const t = (raw ?? '').trim().replace(',', '.');
  if (!new RegExp(`^\\d{1,14}(\\.\\d{1,${scale}})?$`).test(t)) return null;
  const [int, frac = ''] = t.split('.');
  return BigInt(int) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0') || '0');
}

/** Quantidade (2 casas) × valor unitário (4 casas) → montante com 2 casas (meio para cima); `null` se faltar algo. */
export function lineAmount(quantity: string | null, rate: string | null): string | null {
  const q = scaled(quantity, 2);
  const r = scaled(rate, 4);
  if (q === null || r === null) return null;
  const c = (q * r * 2n + 10_000n) / 20_000n;
  const s = c.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Antiguidade legível: "3 anos, 2 meses e 5 dias". */
export function serviceLabel(s: TerminationFacts['service']): string {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const parts = [
    part(s.years, 'ano', 'anos'),
    part(s.months, 'mês', 'meses'),
    part(s.days, 'dia', 'dias'),
  ].filter(Boolean);
  if (!parts.length) return '0 dias';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}`;
}

/** Progresso da checklist (tratadas = feitas ou não aplicáveis). */
export function checklistProgress(tasks: TerminationTask[]): { done: number; total: number } {
  return { done: tasks.filter((t) => t.status !== 'PENDING').length, total: tasks.length };
}

/** Próximo passo do processo, para orientar quem o trata. */
export function nextStep(t: Termination): string {
  switch (t.status) {
    case 'DRAFT':
      return t.blockers?.length
        ? 'Resolva os impedimentos e submeta para aprovação.'
        : 'Complete a liquidação final e submeta para aprovação.';
    case 'PENDING_APPROVAL':
      return 'A aguardar a aprovação (por quem não preparou nem submeteu).';
    case 'APPROVED':
      if (t.lines?.length && (!t.settlementRun || t.settlementRun.status === 'CANCELLED'))
        return 'Gere o lote da liquidação final no processamento salarial.';
      if (t.settlementRun && t.settlementRun.status !== 'CLOSED')
        return `Processe e feche o lote ${t.settlementRun.code}.`;
      return 'Trate a checklist de saída e conclua o processo.';
    case 'SETTLED':
      return 'Processo concluído.';
    default:
      return 'Processo cancelado.';
  }
}
