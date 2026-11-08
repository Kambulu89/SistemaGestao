/** Contratos e carreira (7.3): tipos da API, textos e regras de apresentação (a API decide sempre). */

export type ContractType = 'PERMANENT' | 'FIXED_TERM' | 'UNCERTAIN_TERM';
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'ENDED' | 'CANCELLED';

export interface Terms {
  baseSalary: string;
  weeklyHours: string;
  workSchedule: string | null;
  endDate: string | null;
}

export interface Amendment {
  id: string;
  sequence: number;
  kind: 'CHANGE' | 'RENEWAL';
  effectiveDate: string;
  baseSalary: string | null;
  weeklyHours: string | null;
  workSchedule: string | null;
  endDate: string | null;
  reason: string;
  createdAt: string;
}

export interface Contract {
  id: string;
  version: number;
  employeeId: string;
  code: string;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  probationEndDate: string | null;
  weeklyHours: string;
  workSchedule: string | null;
  currency: string;
  baseSalary: string;
  notes: string | null;
  status: ContractStatus;
  renewalCount: number;
  suspendedFrom: string | null;
  terminationDate: string | null;
  terminationReason: string | null;
  currentTerms: Terms;
  termExceeded: boolean;
  employee?: { id: string; code: string; fullName: string; status: string };
  amendments?: Amendment[];
  events?: { kind: string; date: string; reason: string | null; actor: string | null }[];
  access?: { manage: boolean };
  [key: string]: unknown;
}

export interface Assignment {
  id: string;
  kind: 'HIRE' | 'TRANSFER' | 'PROMOTION' | 'CHANGE';
  validFrom: string;
  validTo: string | null;
  branchId: string | null;
  departmentId: string | null;
  positionId: string | null;
  managerId: string | null;
  costCenterId: string | null;
  branchName: string | null;
  departmentName: string | null;
  positionName: string | null;
  costCenterCode: string | null;
  managerName: string | null;
  reason: string | null;
  actor: string | null;
}

export const CONTRACT_TYPE: Record<ContractType, string> = {
  PERMANENT: 'Por tempo indeterminado',
  FIXED_TERM: 'A termo certo',
  UNCERTAIN_TERM: 'A termo incerto',
};
export const CONTRACT_STATUS: Record<ContractStatus, string> = {
  DRAFT: 'Rascunho',
  ACTIVE: 'Em vigor',
  SUSPENDED: 'Suspenso',
  ENDED: 'Terminado',
  CANCELLED: 'Cancelado',
};
export const CONTRACT_EVENT: Record<string, string> = {
  ACTIVATED: 'Activado',
  SUSPENDED: 'Suspenso',
  RESUMED: 'Retomado',
  AMENDED: 'Adenda',
  RENEWED: 'Renovado',
  TERMINATED: 'Terminado',
  CANCELLED: 'Cancelado',
};
export const ASSIGNMENT_KIND: Record<Assignment['kind'], string> = {
  HIRE: 'Admissão',
  TRANSFER: 'Transferência',
  PROMOTION: 'Promoção',
  CHANGE: 'Alteração',
};

export function contractTone(status: ContractStatus): string {
  if (status === 'ACTIVE') return 'bg-success-soft text-success-text';
  if (status === 'SUSPENDED') return 'bg-warning-soft text-warning-text';
  if (status === 'DRAFT') return 'bg-info-soft text-info-text';
  return 'bg-surface-2 text-muted';
}

export type ContractAction =
  'edit' | 'activate' | 'cancel' | 'amend' | 'renew' | 'suspend' | 'resume' | 'terminate';

/** Acções visíveis por estado (espelho das regras da API, que volta a verificar). */
export function contractActions(
  c: Pick<Contract, 'status' | 'contractType'>,
  manage: boolean,
): ContractAction[] {
  if (!manage) return [];
  switch (c.status) {
    case 'DRAFT':
      return ['edit', 'activate', 'cancel'];
    case 'ACTIVE':
      return [
        'amend',
        ...(c.contractType === 'FIXED_TERM' ? (['renew'] as const) : []),
        'suspend',
        'terminate',
      ];
    case 'SUSPENDED':
      return ['amend', 'resume', 'terminate'];
    default:
      return [];
  }
}

/** Período da colocação em texto ("desde 05/01/2026" ou "05/01/2026 – 31/03/2026"). */
export function periodLabel(
  a: Pick<Assignment, 'validFrom' | 'validTo'>,
  fmt: (d: string) => string,
) {
  return a.validTo ? `${fmt(a.validFrom)} – ${fmt(a.validTo)}` : `desde ${fmt(a.validFrom)}`;
}

/** O que muda numa adenda, em texto (a remuneração com moeda). */
export function amendmentSummary(
  a: Pick<Amendment, 'baseSalary' | 'weeklyHours' | 'workSchedule' | 'endDate'>,
  currency: string,
  money: (v: string) => string,
  date: (v: string) => string,
): string {
  const parts: string[] = [];
  if (a.baseSalary !== null) parts.push(`remuneração ${money(a.baseSalary)} ${currency}`);
  if (a.weeklyHours !== null) parts.push(`${a.weeklyHours} h/semana`);
  if (a.workSchedule !== null) parts.push(`horário: ${a.workSchedule}`);
  if (a.endDate !== null) parts.push(`termo ${date(a.endDate)}`);
  return parts.join(' · ');
}

/** Corpo do pedido de criação de contrato (vazios fora; quantidade de horas e salário em texto decimal). */
export function contractPayload(
  form: Record<string, unknown>,
  original: Record<string, unknown> | null,
) {
  const keys = [
    'code',
    'contractType',
    'startDate',
    'endDate',
    'probationEndDate',
    'weeklyHours',
    'workSchedule',
    'currency',
    'baseSalary',
    'notes',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    let v = form[k];
    if (typeof v === 'number') v = String(v);
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (original) {
      if ((original[k] ?? null) !== v) out[k] = v;
    } else if (v !== null) out[k] = v;
  }
  return out;
}
