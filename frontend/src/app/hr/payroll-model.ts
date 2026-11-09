/** Processamento salarial (7.7): tipos da API e apresentação (a API calcula e decide sempre). */

export type RunKind = 'REGULAR' | 'EXTRA' | 'RETRO';
export type RunStatus =
  'DRAFT' | 'CALCULATED' | 'PENDING_APPROVAL' | 'APPROVED' | 'CLOSED' | 'CANCELLED';

export interface Bracket {
  lower: string;
  upper: string | null;
  fixedAmount: string;
  rate: string;
  excessOver: string;
}

export interface TestCase {
  description: string;
  source: string;
  baseSalary: string;
  allowancesSubject: string;
  allowancesIrtOnly: string;
  allowancesExempt: string;
  expectedInssEmployee: string;
  expectedIrt: string;
  expectedInssEmployer: string | null;
  expectedNet: string | null;
}

export interface CaseResult {
  sequence: number;
  description: string;
  pass: boolean;
  mismatches: { field: string; expected: string; actual: string }[];
  errors: { message: string }[];
  actual: Record<string, string>;
}

export interface RuleSet {
  id: string;
  version: number;
  code: string;
  name: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
  inssEmployeeRate: string;
  inssEmployerRate: string;
  baseIrtSubject: boolean;
  baseInssSubject: boolean;
  irtBaseDeductsInss: boolean;
  dayBasis: 'CALENDAR' | 'FIXED_30';
  legalReference: string;
  status: 'DRAFT' | 'PUBLISHED';
  confirmedBy: string | null;
  confirmedAt: string | null;
  confirmationNote: string | null;
  brackets: Bracket[];
  testCases: TestCase[];
}

export interface RunTotals {
  gross: string;
  inssEmployee: string;
  irt: string;
  deductions: string;
  loans: string;
  net: string;
  inssEmployer: string;
  employerCost: string;
}

export interface RunResult {
  id: string;
  employee: { id: string; code: string; fullName: string };
  status: 'OK' | 'ERROR';
  currency: string | null;
  gross: string | null;
  inssEmployee: string | null;
  irt: string | null;
  deductions: string | null;
  loans: string | null;
  net: string | null;
  inssEmployer: string | null;
  employerCost: string | null;
  errors: { path: string; code: string; message: string }[];
  [key: string]: unknown;
}

export interface PayrollRun {
  id: string;
  version: number;
  code: string;
  kind: RunKind;
  description: string | null;
  status: RunStatus;
  legalEntity: { id: string; code: string; name: string };
  period: string;
  periodStatus: string;
  targetPeriod: string | null;
  ruleSet: { id: string; code: string } | null;
  excludedEmployeeIds: string[];
  employeesCount: number;
  errorsCount: number;
  totals: RunTotals;
  createdBy: string | null;
  calculatedBy: string | null;
  calculatedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  closedBy: string | null;
  closedAt: string | null;
  results?: RunResult[];
  inputs?: {
    id: string;
    employee: { id: string; code: string; fullName: string };
    component: { id: string; code: string; name: string; kind: string };
    amount: string;
    note: string | null;
  }[];
  access?: { manage: boolean; edit: boolean; approve: boolean };
  [key: string]: unknown;
}

export interface ResultDetail {
  id: string;
  employee: { id: string; code: string; fullName: string };
  status: 'OK' | 'ERROR';
  currency: string | null;
  bases: { inss: string | null; irt: string | null };
  totals: Record<keyof RunTotals, string | null>;
  errors: { path: string; code: string; message: string }[];
  lines: {
    code: string;
    name: string;
    kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER';
    source: string;
    amount: string;
    irtSubject: boolean;
    inssSubject: boolean;
  }[];
  snapshot: { rules?: { code: string; validFrom: string; legalReference: string } | null } & Record<
    string,
    unknown
  >;
}

export const RUN_KIND: Record<RunKind, string> = {
  REGULAR: 'Regular',
  EXTRA: 'Extra',
  RETRO: 'Retroactivo',
};
export const RUN_STATUS: Record<RunStatus, string> = {
  DRAFT: 'Por calcular',
  CALCULATED: 'Calculado',
  PENDING_APPROVAL: 'Aguarda aprovação',
  APPROVED: 'Aprovado',
  CLOSED: 'Fechado',
  CANCELLED: 'Cancelado',
};
export const DAY_BASIS: Record<RuleSet['dayBasis'], string> = {
  CALENDAR: 'Dias do mês',
  FIXED_30: '30 dias',
};

export function runTone(s: RunStatus): string {
  if (s === 'CLOSED') return 'bg-success-soft text-success-text';
  if (s === 'APPROVED') return 'bg-info-soft text-info-text';
  if (s === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  if (s === 'CALCULATED') return 'bg-primary-soft text-on-primary-soft';
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
export function monthName(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} de ${m[1]}` : period;
}

/** Título curto de um lote: "Regular · novembro de 2026" ou "Retroactivo de setembro de 2026 (em outubro de 2026)". */
export function runTitle(r: Pick<PayrollRun, 'kind' | 'period' | 'targetPeriod'>): string {
  if (r.kind === 'RETRO' && r.targetPeriod)
    return `Retroactivo de ${monthName(r.targetPeriod)} (em ${monthName(r.period)})`;
  return `${RUN_KIND[r.kind]} · ${monthName(r.period)}`;
}

/** Percentagem sem zeros à direita ("3.0000" → "3", "6.5000" → "6,5"). */
export function pct(v: string): string {
  return v.replace(/\.?0+$/, '').replace('.', ',');
}

/** O que falta para o lote avançar, em texto (só orientação; a API decide). */
export function nextStep(r: Pick<PayrollRun, 'status' | 'errorsCount' | 'employeesCount'>): string {
  switch (r.status) {
    case 'DRAFT':
      return 'Calcule o lote: é uma simulação sem efeitos e pode repetir-se.';
    case 'CALCULATED':
      if (r.errorsCount)
        return `Há ${r.errorsCount} colaborador(es) com erros: corrija os dados e recalcule, ou exclua-os.`;
      if (!r.employeesCount) return 'O lote não tem colaboradores.';
      return 'Peça aprovação: outra pessoa com permissão aprova.';
    case 'PENDING_APPROVAL':
      return 'Aguarda aprovação (nunca de quem preparou ou calculou, nem de quem tem o recibo no lote).';
    case 'APPROVED':
      return 'Feche o lote: regista os descontos dos empréstimos e, no regular, fecha o mês.';
    case 'CLOSED':
      return 'Fechado: não se altera. Correcções fazem-se num retroactivo.';
    default:
      return 'Cancelado.';
  }
}

/** Escalões vindos do formulário: texto com vírgula → ponto; limite superior vazio = aberto. */
export function bracketsPayload(rows: Bracket[]): Bracket[] {
  const n = (v: string) => v.trim().replace(/\s/g, '').replace(',', '.');
  return rows.map((b) => ({
    lower: n(b.lower),
    upper: b.upper === null || n(b.upper) === '' ? null : n(b.upper),
    fixedAmount: n(b.fixedAmount) || '0',
    rate: n(b.rate),
    excessOver: n(b.excessOver) || n(b.lower),
  }));
}

export const CASE_FIELD: Record<string, string> = {
  inssEmployee: 'INSS do trabalhador',
  irt: 'IRT',
  inssEmployer: 'INSS da empresa',
  net: 'Líquido',
};

/** O que ainda falta para publicar uma versão (orientação; a API verifica tudo de novo). */
export function publishBlockers(
  r: Pick<RuleSet, 'status' | 'testCases' | 'confirmedAt'>,
): string[] {
  if (r.status !== 'DRAFT') return [];
  const out: string[] = [];
  if (!r.testCases.length) out.push('Registe pelo menos um caso de teste oficial, com a fonte.');
  if (!r.confirmedAt) out.push('Confirme que os valores correspondem às normas em vigor.');
  return out;
}

/** Casos vindos do formulário: vírgula decimal → ponto; esperados opcionais vazios → `null`. */
export function testCasesPayload(rows: TestCase[]): TestCase[] {
  const n = (v: string | null) => (v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  return rows.map((c) => ({
    description: c.description.trim(),
    source: c.source.trim(),
    baseSalary: n(c.baseSalary),
    allowancesSubject: n(c.allowancesSubject) || '0',
    allowancesIrtOnly: n(c.allowancesIrtOnly) || '0',
    allowancesExempt: n(c.allowancesExempt) || '0',
    expectedInssEmployee: n(c.expectedInssEmployee),
    expectedIrt: n(c.expectedIrt),
    expectedInssEmployer: n(c.expectedInssEmployer) || null,
    expectedNet: n(c.expectedNet) || null,
  }));
}
