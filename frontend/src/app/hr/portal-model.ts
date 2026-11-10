/** Portais e relatórios de RH (7.12): tipos, rótulos e linhas para exportação. Cálculos são do servidor. */
import { formatMoney } from '../ui/money-input';
import { CONTRACT_TYPE, type ContractType } from './contracts-model';
import { TERMINATION_REASON, INITIATIVE, type TerminationReason } from './termination-model';
import type { LeaveRequest } from './leave-model';

export interface MySpace {
  profile: Record<string, unknown> & {
    id: string;
    version: number;
    code: string;
    fullName: string;
    legalEntity: { code: string; name: string };
    departmentName: string | null;
    positionName: string | null;
    manager: { code: string; fullName: string } | null;
  };
  contracts: {
    id: string;
    code: string;
    contractType: ContractType;
    status: string;
    currency: string;
    startDate: string;
    endDate: string | null;
    probationEndDate: string | null;
    terminationDate: string | null;
  }[];
  currentTerms: {
    contractId: string;
    currency: string;
    baseSalary: string | null;
    weeklyHours: string | null;
    workSchedule: string | null;
    endDate: string | null;
  } | null;
  loans: {
    id: string;
    code: string;
    kind: string;
    status: string;
    currency: string;
    principal: string;
    outstanding: string;
  }[];
  certificates: {
    id: string;
    name: string;
    issuer: string;
    number: string | null;
    issuedOn: string;
    expiresOn: string | null;
  }[];
  selfEditable: string[];
}

export interface TeamMember {
  id: string;
  code: string;
  fullName: string;
  status: string;
  hireDate: string;
  depth: number;
  positionName: string | null;
  departmentName: string | null;
  managerName: string | null;
  absentToday: (LeaveRequest & { canDecide: boolean }) | null;
  nextAbsence: (LeaveRequest & { canDecide: boolean }) | null;
  pendingRequests: number;
  alerts: { kind: string; date: string; label: string }[];
}

export interface Team {
  members: TeamMember[];
  summary: { size: number; direct: number; absentToday: number; toDecide: number; alerts: number };
  pending: (LeaveRequest & { canDecide: boolean })[];
  absences: (LeaveRequest & { canDecide: boolean })[];
  horizon: string;
}

export interface Group {
  key: string | null;
  label: string;
  count: number;
}
export interface Headcount {
  date: string;
  total: number;
  byLegalEntity: Group[];
  byDepartment: Group[];
  byPosition: Group[];
  byContractType: Group[];
  hiresYearToDate: number;
  exitsYearToDate: number;
}
export interface Turnover {
  year: number;
  months: {
    month: string;
    start: number;
    end: number;
    hires: number;
    exits: number;
    rate: string | null;
  }[];
  hires: number;
  exits: number;
  averageHeadcount: string | null;
  rate: string | null;
  byReason: { key: string | null; count: number }[];
  byInitiative: { key: string | null; count: number }[];
}
export interface LeaveReport {
  year: number;
  rows: {
    employee: { id: string; code: string; fullName: string };
    departmentName: string | null;
    entitled: string;
    taken: string;
    pending: string;
    balance: string;
  }[];
  totals: { employees: number; entitled: string; taken: string; pending: string; balance: string };
  byDepartment: {
    departmentName: string | null;
    employees: number;
    entitled: string;
    taken: string;
    balance: string;
  }[];
}
export interface PayrollFigures {
  currency: string;
  employees: number;
  gross: string;
  inssEmployee: string;
  inssEmployer: string;
  irt: string;
  deductions: string;
  loans: string;
  net: string;
  employerCost: string;
}
export interface PayrollReport {
  year: number;
  legalEntities: { id: string; code: string; name: string }[];
  months: (PayrollFigures & { month: string })[];
  byKind: (PayrollFigures & { kind: string })[];
  byDepartment: (PayrollFigures & { departmentName: string })[];
  totals: PayrollFigures[];
}

export const SELF_FIELD_LABEL: Record<string, string> = {
  personalEmail: 'Email pessoal',
  personalPhone: 'Telefone pessoal',
  addressLine: 'Morada',
  city: 'Cidade',
  province: 'Província',
  countryCode: 'País (ISO)',
  emergencyName: 'Contacto de emergência',
  emergencyPhone: 'Telefone de emergência',
  emergencyRelation: 'Relação',
};

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
/** "2026-03" → "mar 2026". */
export function shortMonth(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** "12.50" → "12,50 %"; `null` → "—". */
export function pctLabel(v: string | null): string {
  return v === null ? '—' : `${v.replace('.', ',')} %`;
}

export function contractTypeLabel(key: string | null): string {
  return key ? (CONTRACT_TYPE[key as ContractType] ?? key) : 'Sem contrato';
}

export function reasonLabel(key: string | null): string {
  return key ? (TERMINATION_REASON[key as TerminationReason] ?? key) : '—';
}

export function initiativeLabel(key: string | null): string {
  return key ? (INITIATIVE[key as keyof typeof INITIATIVE] ?? key) : '—';
}

/** Linhas CSV da folha salarial (valores canónicos, sem separadores de milhares). */
export function payrollCsvRows(r: PayrollReport): { headers: string[]; rows: unknown[][] } {
  const headers = [
    'Mês',
    'Moeda',
    'Colaboradores',
    'Bruto',
    'INSS trabalhador',
    'INSS empresa',
    'IRT',
    'Descontos',
    'Empréstimos',
    'Líquido',
    'Custo empresa',
  ];
  const line = (label: string, f: PayrollFigures) => [
    label,
    f.currency,
    f.employees,
    f.gross,
    f.inssEmployee,
    f.inssEmployer,
    f.irt,
    f.deductions,
    f.loans,
    f.net,
    f.employerCost,
  ];
  return {
    headers,
    rows: [
      ...r.months.map((m) => line(m.month, m)),
      ...r.totals.map((t) => line(`Total ${r.year}`, t)),
    ],
  };
}

/** Até `max` barras (as maiores); o resto junta-se em "Outros", para o gráfico caber em qualquer largura. */
export function topBars(groups: { label: string; count: number }[], max = 8) {
  const sorted = [...groups].sort((a, b) => b.count - a.count);
  const head = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1);
  const bars = head.map((g) => ({ label: g.label, value: g.count }));
  if (rest.length === 1) bars.push({ label: rest[0].label, value: rest[0].count });
  else if (rest.length)
    bars.push({ label: 'Outros', value: rest.reduce((a, g) => a + g.count, 0) });
  return bars;
}

/** Montante em formato português. */
export const money = (v: string) => formatMoney(v);
