import type { ConditionDto } from '../../../core/dynamic/http/dynamic-dto';

/**
 * Construtor das condições de apresentação de um formulário. O servidor guarda uma árvore declarativa; o
 * construtor só representa o caso comum — comparações de campos ligadas por «e» ou «ou» — e o que for mais rico
 * (aninhado, `in`/`nin`) mostra-se em só de leitura e mantém-se tal como está.
 */
export type FormClauseOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'notEmpty' | 'empty';

export const FORM_CLAUSE_OPERATORS: readonly { value: FormClauseOperator; label: string }[] = [
  { value: 'eq', label: 'é igual a' },
  { value: 'neq', label: 'é diferente de' },
  { value: 'gt', label: 'é maior que' },
  { value: 'gte', label: 'é maior ou igual a' },
  { value: 'lt', label: 'é menor que' },
  { value: 'lte', label: 'é menor ou igual a' },
  { value: 'notEmpty', label: 'está preenchido' },
  { value: 'empty', label: 'está vazio' },
];

export interface FormClause {
  /** Código do campo no servidor (`snake_case`). */
  readonly field: string;
  readonly operator: FormClauseOperator;
  readonly value: string;
}

export interface FormConditionDraft {
  readonly join: 'and' | 'or';
  readonly clauses: readonly FormClause[];
}

/** Como o campo guarda o valor que a condição compara (números e decimais comparam-se como número). */
export type ConditionKind = 'number' | 'boolean' | 'text';

type Scalar = string | number | boolean | null;

/** Texto escrito → valor comparável; `undefined` quando não serve para o tipo do campo. */
export function conditionLiteral(text: string, kind: ConditionKind): Scalar | undefined {
  const trimmed = text.trim();
  switch (kind) {
    case 'boolean':
      return trimmed === 'true' ? true : trimmed === 'false' ? false : undefined;
    case 'number':
      return trimmed !== '' && Number.isFinite(Number(trimmed)) ? Number(trimmed) : undefined;
    case 'text':
      return trimmed === '' ? undefined : trimmed;
  }
}

export type BuildConditionResult =
  | { readonly ok: true; readonly condition: ConditionDto }
  | { readonly ok: false; readonly message: string };

const COMPARISONS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);

export function buildFormCondition(
  draft: FormConditionDraft,
  kindOf: (field: string) => ConditionKind | undefined,
): BuildConditionResult {
  if (draft.clauses.length === 0) return { ok: false, message: 'Indique pelo menos uma condição.' };
  const parts: ConditionDto[] = [];
  for (const [index, clause] of draft.clauses.entries()) {
    const kind = kindOf(clause.field);
    if (!clause.field || !kind)
      return { ok: false, message: `Condição ${index + 1}: escolha um campo.` };
    if (clause.operator === 'notEmpty' || clause.operator === 'empty') {
      parts.push({ op: clause.operator, field: clause.field });
      continue;
    }
    const value = conditionLiteral(clause.value, kind);
    if (value === undefined)
      return { ok: false, message: `Condição ${index + 1}: valor inválido para o campo.` };
    parts.push({ op: clause.operator, field: clause.field, value });
  }
  return {
    ok: true,
    condition: parts.length === 1 ? parts[0]! : { op: draft.join, conditions: parts },
  };
}

function clauseOf(node: ConditionDto): FormClause | null {
  if (node.op === 'notEmpty' || node.op === 'empty')
    return { field: node.field, operator: node.op, value: '' };
  if (COMPARISONS.has(node.op) && 'value' in node) {
    return {
      field: node.field,
      operator: node.op as FormClauseOperator,
      value: node.value === null ? '' : String(node.value),
    };
  }
  return null;
}

/** Condição → rascunho do construtor; `null` quando é mais rica do que o construtor representa. */
export function parseFormCondition(condition: ConditionDto | undefined): FormConditionDraft | null {
  if (!condition) return null;
  if (condition.op === 'and' || condition.op === 'or') {
    if (condition.conditions.length < 2) return null;
    const clauses = condition.conditions.map(clauseOf);
    return clauses.every((c): c is FormClause => c !== null)
      ? { join: condition.op, clauses }
      : null;
  }
  const single = clauseOf(condition);
  return single ? { join: 'and', clauses: [single] } : null;
}

/** Descrição curta e legível de uma condição (para a lista), com o rótulo de cada campo. */
export function describeFormCondition(
  condition: ConditionDto,
  labelOf: (field: string) => string,
): string {
  switch (condition.op) {
    case 'and':
    case 'or':
      return condition.conditions
        .map((c) => describeFormCondition(c, labelOf))
        .join(condition.op === 'and' ? ' e ' : ' ou ');
    case 'not':
      return `não (${describeFormCondition(condition.condition, labelOf)})`;
    case 'in':
    case 'nin':
      return `${labelOf(condition.field)} ${condition.op === 'in' ? 'está em' : 'não está em'} ${condition.values.join(', ')}`;
    case 'empty':
    case 'notEmpty':
      return `${labelOf(condition.field)} ${condition.op === 'empty' ? 'está vazio' : 'está preenchido'}`;
    default: {
      const label =
        FORM_CLAUSE_OPERATORS.find((o) => o.value === condition.op)?.label ?? condition.op;
      return `${labelOf(condition.field)} ${label} ${String(condition.value)}`;
    }
  }
}
