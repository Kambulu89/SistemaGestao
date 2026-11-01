import { detailedErrorMessage } from '../../../core/api/error-message';
import type { Tone } from '../../../shared/ui/badge/badge';
import type {
  DatasetField,
  ExportStatus,
  FieldType,
  FilterDto,
  FilterOp,
  MeasureFn,
  RunResultDto,
  WidgetType,
} from './reporting.api';

export const OPS_BY_TYPE: Readonly<Record<FieldType, readonly FilterOp[]>> = {
  string: ['eq', 'neq', 'contains', 'in'],
  enum: ['eq', 'neq', 'in'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  decimal: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  integer: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
};

export const OP_LABEL: Readonly<Record<FilterOp, string>> = {
  eq: 'igual a',
  neq: 'diferente de',
  gt: 'maior que',
  gte: 'maior ou igual a',
  lt: 'menor que',
  lte: 'menor ou igual a',
  between: 'entre',
  in: 'um de (separados por vírgula)',
  contains: 'contém',
};

export const MEASURE_LABEL: Readonly<Record<MeasureFn, string>> = {
  count: 'Contagem',
  sum: 'Soma',
  avg: 'Média',
  min: 'Mínimo',
  max: 'Máximo',
};

export const WIDGET_LABEL: Readonly<Record<WidgetType, string>> = {
  KPI: 'Indicador',
  TABLE: 'Tabela',
  BAR: 'Barras',
  LINE: 'Linha',
  PIE: 'Circular',
};

export const EXPORT_STATUS: Readonly<Record<ExportStatus, { label: string; tone: Tone }>> = {
  QUEUED: { label: 'Na fila', tone: 'neutral' },
  RUNNING: { label: 'A gerar', tone: 'brand' },
  READY: { label: 'Pronta', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
  EXPIRED: { label: 'Expirada', tone: 'neutral' },
};

const ERRORS: Readonly<Record<string, string>> = {
  FIELD_NOT_ALLOWED: 'Há um campo que não existe ou a que não tem acesso.',
  SELECT_NOT_GROUPED: 'Com agrupamento, só se podem mostrar os campos agrupados e as medidas.',
  REPORT_PUBLISHED_IMMUTABLE: 'Um relatório publicado não se altera: duplique-o.',
  REPORT_CODE_TAKEN: 'Já existe um relatório com este código.',
  REPORT_IN_USE: 'O relatório está num painel.',
  REPORT_NOT_PUBLISHED: 'Só um relatório publicado entra num painel ou se exporta.',
  REPORT_NOT_SHARED: 'Num painel da organização só entram relatórios da organização.',
  REPORT_NOT_VISIBLE: 'O relatório deste widget não está disponível.',
  FORMAT_NOT_SUPPORTED: 'Por agora só se exporta em CSV.',
  EXPORT_EXPIRED: 'A exportação expirou: peça outra.',
  EXPORT_NOT_READY: 'A exportação ainda não está pronta.',
  EXPORT_ACCESS_REVOKED: 'Já não tem acesso aos dados desta exportação.',
  ACCESS_REVOKED: 'Quem pediu a exportação já não tinha acesso quando ela correu.',
  ROW_LIMIT: 'A exportação excede o limite de linhas: reduza com filtros.',
  PERMISSION_DENIED: 'Não tem permissão para estes dados.',
  TOO_SHORT: 'Escreva pelo menos 2 caracteres.',
  UNKNOWN_DATASET: 'Dataset desconhecido.',
  STALE_VERSION: 'Os dados mudaram entretanto. Recarregue e tente de novo.',
};

export function reportingError(raw: unknown, fallback: string): string {
  // `rxResource` embrulha o erro que não é `Error` e guarda o original em `cause`.
  const error = raw instanceof Error && raw.cause ? raw.cause : raw;
  const code = (error as { code?: string } | null)?.code;
  if (code && ERRORS[code]) return ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) return fields.map((f) => ERRORS[f.code] ?? f.message).join(' ');
  return detailedErrorMessage(error, fallback);
}

export const errorTextOf = (code: string, message: string): string => ERRORS[code] ?? message;

/** Decimais chegam como texto; mostram-se com separador de milhares, sem passar por float. */
export function formatCell(value: unknown, type: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value);
  if (type === 'decimal' || type === 'measure') {
    const m = /^(-?)(\d+)(\.\d+)?$/.exec(text);
    if (m)
      return `${m[1]}${(m[2] as string).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${(m[3] ?? '').replace('.', ',')}`;
  }
  return text;
}

/** Constrói um filtro a partir do que a pessoa escreveu; devolve o motivo quando não serve. */
export function buildFilter(
  field: DatasetField,
  op: FilterOp,
  raw: string,
  raw2 = '',
): { filter: FilterDto } | { error: string } {
  const one = (text: string): unknown | undefined => {
    const t = text.trim();
    if (!t) return undefined;
    if (field.type === 'integer') return /^-?\d+$/.test(t) ? Number(t) : undefined;
    if (field.type === 'decimal') return /^-?\d{1,15}(\.\d{1,6})?$/.test(t) ? t : undefined;
    if (field.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
    return t;
  };
  const hint =
    field.type === 'date'
      ? 'Indique a data como AAAA-MM-DD.'
      : field.type === 'decimal' || field.type === 'integer'
        ? 'Indique um número.'
        : 'Indique um valor.';
  if (op === 'between') {
    const a = one(raw);
    const b = one(raw2);
    return a === undefined || b === undefined
      ? { error: hint }
      : { filter: { field: field.code, op, value: [a, b] } };
  }
  if (op === 'in') {
    const values = raw.split(',').map(one);
    return values.length === 0 || values.some((v) => v === undefined)
      ? { error: hint }
      : { filter: { field: field.code, op, value: values } };
  }
  const value = one(raw);
  return value === undefined ? { error: hint } : { filter: { field: field.code, op, value } };
}

export const describeFilter = (f: FilterDto, fields: readonly DatasetField[]): string => {
  const label = fields.find((x) => x.code === f.field)?.label ?? f.field;
  const value = Array.isArray(f.value)
    ? f.value.join(f.op === 'between' ? ' a ' : ', ')
    : String(f.value);
  return `${label} ${OP_LABEL[f.op].replace(' (separados por vírgula)', '')} ${value}`;
};

export interface ChartPoint {
  readonly label: string;
  readonly value: number;
}

/**
 * Pontos para os gráficos: a primeira coluna é a categoria e a primeira medida o valor. O número serve só para
 * desenhar (alturas e ângulos); os valores exactos mostram-se sempre como texto.
 */
export function chartPoints(result: RunResultDto): ChartPoint[] {
  const [category, measure] = result.columns;
  if (!category || !measure) return [];
  return result.rows
    .map((row) => ({
      label: String(row[category.code] ?? '—'),
      value: Number(row[measure.code] ?? 0),
    }))
    .filter((p) => Number.isFinite(p.value));
}
