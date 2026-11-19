/** Compensação e benefícios (7.5): tipos da API, textos e regras de apresentação (a API decide sempre). */

export type PayCalculation = 'FIXED' | 'PERCENT_OF_BASE' | 'VARIABLE';
export type ProposalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPLIED' | 'REJECTED' | 'CANCELLED';

export interface Incidence {
  id?: string;
  validFrom: string;
  irtSubject: boolean;
  irtExemptAmount: string | null;
  inssSubject: boolean;
  legalReference?: string;
}

export interface PayComponent {
  id: string;
  version: number;
  code: string;
  name: string;
  kind: 'EARNING' | 'DEDUCTION';
  category: string;
  calculation: PayCalculation;
  recurring: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  currentIncidence?: {
    irtSubject: boolean;
    inssSubject: boolean;
    irtExemptAmount: string | null;
  } | null;
  incidences?: Incidence[];
}

export interface ProposalLine {
  componentId: string;
  code?: string;
  name?: string;
  kind?: string;
  calculation?: PayCalculation;
  action: 'SET' | 'REMOVE';
  amount: string | null;
  percent: string | null;
}

export interface Proposal {
  id: string;
  version: number;
  employee: { id: string; code: string; fullName: string };
  effectiveDate: string;
  reason: string;
  status: ProposalStatus;
  approvalRequestId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  createdBy: string | null;
  lines: ProposalLine[];
  approvalMode?: 'WORKFLOW' | 'DIRECT';
  access?: { manage: boolean; approve: boolean };
  [key: string]: unknown;
}

export interface CompensationAt {
  date: string;
  contractId: string;
  currency: string;
  baseSalary: string;
  lines: {
    componentId: string;
    code: string;
    name: string;
    kind: 'EARNING' | 'DEDUCTION';
    category: string;
    amount: string;
    percent: string | null;
    incidence: Incidence | null;
  }[];
}

export interface CompensationSummary {
  employee: { id: string; code: string; fullName: string };
  at: CompensationAt | null;
  history: {
    id: string;
    componentId: string;
    code: string;
    name: string;
    kind: string;
    amount: string | null;
    percent: string | null;
    currency: string;
    validFrom: string;
    validTo: string | null;
  }[];
  proposals: Proposal[];
  access: { manage: boolean; approve: boolean };
}

export const PAY_CATEGORY: Record<string, string> = {
  ALLOWANCE: 'Subsídio',
  BONUS: 'Prémio',
  OVERTIME: 'Horas extra',
  BENEFIT: 'Abono / benefício',
  DEDUCTION: 'Desconto',
  OTHER: 'Outro',
};
export const PAY_CALCULATION: Record<PayCalculation, string> = {
  FIXED: 'Montante fixo',
  PERCENT_OF_BASE: '% do salário base',
  VARIABLE: 'Variável (por processamento)',
};
export const PROPOSAL_STATUS: Record<ProposalStatus, string> = {
  DRAFT: 'Rascunho',
  PENDING_APPROVAL: 'Aguarda aprovação',
  APPLIED: 'Aplicada',
  REJECTED: 'Recusada',
  CANCELLED: 'Cancelada',
};

export function proposalTone(s: ProposalStatus): string {
  if (s === 'APPLIED') return 'bg-success-soft text-success-text';
  if (s === 'PENDING_APPROVAL') return 'bg-warning-soft text-warning-text';
  if (s === 'DRAFT') return 'bg-info-soft text-info-text';
  if (s === 'REJECTED') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

/** Texto da incidência ("IRT (isento até 30 000,00) · INSS"; "Sem IRT nem INSS"; "Incidência por definir"). */
export function incidenceLabel(
  i: Incidence | null | undefined,
  money: (v: string) => string,
): string {
  if (!i) return 'Incidência por definir';
  const parts: string[] = [];
  if (i.irtSubject)
    parts.push(i.irtExemptAmount ? `IRT (isento até ${money(i.irtExemptAmount)})` : 'IRT');
  if (i.inssSubject) parts.push('INSS');
  return parts.length ? parts.join(' · ') : 'Sem IRT nem INSS';
}

/** Valor de uma linha de proposta em texto. */
export function lineValue(
  l: Pick<ProposalLine, 'action' | 'amount' | 'percent'>,
  money: (v: string) => string,
) {
  if (l.action === 'REMOVE') return 'Remover';
  if (l.percent) return `${l.percent.replace(/\.?0+$/, '')}% do salário base`;
  return l.amount ? money(l.amount) : '—';
}

/** Corpo das linhas a enviar: só o valor que o cálculo do componente usa; remover sem valor. */
export function linesPayload(
  lines: { componentId: string | null; action: 'SET' | 'REMOVE'; value: string }[],
  calc: (componentId: string) => PayCalculation | undefined,
) {
  return lines
    .filter((l) => l.componentId)
    .map((l) => {
      const v = l.value.trim().replace(',', '.');
      if (l.action === 'REMOVE') return { componentId: l.componentId!, action: 'REMOVE' as const };
      return calc(l.componentId!) === 'PERCENT_OF_BASE'
        ? { componentId: l.componentId!, action: 'SET' as const, percent: v }
        : { componentId: l.componentId!, action: 'SET' as const, amount: v };
    });
}
