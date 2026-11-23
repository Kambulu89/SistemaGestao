/** Avaliação de fornecedores (9.11): tipos da API, rótulos e cores. */
export type Criterion = 'quality' | 'delivery' | 'compliance' | 'cost';
export type Rating = 'A' | 'B' | 'C' | 'D';
export type Weights = Record<Criterion, number>;
export type Indicators = Record<Criterion, { score: string | null; evidence: number }>;

export const CRITERIA: Criterion[] = ['quality', 'delivery', 'compliance', 'cost'];
export const CRITERION: Record<Criterion, string> = {
  quality: 'Qualidade',
  delivery: 'Prazo',
  compliance: 'Conformidade',
  cost: 'Custo',
};
export const CRITERION_HINT: Record<Criterion, string> = {
  quality: 'Aceite sem devolução ÷ entregue, por linha de recepção.',
  delivery: 'Linhas recebidas até à data prevista ÷ linhas com data.',
  compliance: 'Facturas validadas sem excepção ÷ validadas e devolvidas.',
  cost: 'Menor preço proposto ÷ preço do fornecedor, por linha de cotação.',
};
export const RATING_HINT: Record<Rating, string> = {
  A: '85 ou mais',
  B: '70 a 84,99',
  C: '50 a 69,99',
  D: 'abaixo de 50',
};
export const SLA_METRIC: Record<string, string> = {
  DELIVERY_DAYS: 'Prazo de entrega (dias)',
  FILL_RATE: 'Taxa de entrega (%)',
  QUALITY_RATE: 'Taxa de qualidade (%)',
  RESPONSE_HOURS: 'Tempo de resposta (horas)',
  OTHER: 'Outro',
};

export interface Published {
  id: string;
  supplier: { id: string; code: string; name: string };
  periodFrom: string;
  periodTo: string;
  weights: Weights;
  indicators: Indicators;
  score: string | null;
  rating: Rating | null;
  comment: string | null;
  superseded: boolean;
  publishedAt: string;
  publishedBy: string | null;
}

export interface Ranking {
  period: { from: string; to: string };
  weights: Weights;
  items: {
    supplier: { id: string; code: string; name: string };
    indicators: Indicators;
    score: string | null;
    rating: Rating | null;
    latest: { id: string; rating: Rating | null; score: string | null; periodTo: string } | null;
  }[];
  summary: Partial<Record<Rating | 'none', number>>;
}

export interface SupplierEvaluation {
  supplier: { id: string; code: string; name: string };
  period: { from: string; to: string };
  weights: Weights;
  scopeAll: boolean;
  indicators: Indicators;
  score: string | null;
  rating: Rating | null;
  evidence: {
    receipts: {
      id: string;
      number: string;
      order: { id: string; number: string };
      receivedOn: string;
      expectedOn: string | null;
      lines: number;
      rejectedLines: number;
      returnedLines: number;
      late: boolean;
    }[];
    invoices: {
      id: string;
      number: string | null;
      invoiceNumber: string;
      date: string;
      status: string;
      excepted: boolean;
    }[];
    rfqs: { id: string; number: string; lines: number; cheapest: number }[];
  };
  sla: {
    contract: { id: string; number: string; title: string };
    metric: string;
    description: string | null;
    target: string;
    actual: string | null;
    evidence: number;
    met: boolean | null;
  }[];
  history: Published[];
  can: { publish: boolean };
}

export function ratingTone(r: Rating | null | undefined): string {
  if (r === 'A') return 'bg-success-soft text-success-text';
  if (r === 'B') return 'bg-primary-soft text-on-primary-soft';
  if (r === 'C') return 'bg-warning-soft text-warning-text';
  if (r === 'D') return 'bg-danger-soft text-danger-text';
  return 'bg-surface-2 text-muted';
}

/** Primeiro dia do ano e hoje (período por omissão). */
export function defaultPeriod(today = new Date()): { from: string; to: string } {
  const to = today.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 4)}-01-01`, to };
}

/** Nota com vírgula decimal e "—" sem provas. */
export const scoreLabel = (s: string | null | undefined) => (s ? s.replace('.', ',') : '—');

export const weightsSum = (w: Weights) => CRITERIA.reduce((s, c) => s + (Number(w[c]) || 0), 0);
