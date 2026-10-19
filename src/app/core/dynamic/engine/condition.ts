import { type Condition, type ConditionScalar, STATUS_KEY } from '../models/condition.model';
import type { FieldValue } from '../models/field-definition.model';

export interface ConditionContext {
  readonly values: Readonly<Record<string, FieldValue | undefined>>;
  readonly status?: string | null;
}

/** Limite de aninhamento: uma condição mais profunda é inválida e avalia-se como falsa. */
export const MAX_CONDITION_DEPTH = 8;

export function isEmptyValue(value: FieldValue | undefined): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function lookup(context: ConditionContext, field: string): FieldValue | undefined {
  return field === STATUS_KEY ? (context.status ?? null) : context.values[field];
}

/** Compara dois escalares do mesmo tipo; `null` quando não são comparáveis. Datas ISO comparam-se como texto. */
export function compareScalars(actual: unknown, expected: unknown): number | null {
  if (typeof actual === 'number' && typeof expected === 'number') return actual - expected;
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual < expected ? -1 : actual > expected ? 1 : 0;
  }
  return null;
}

function equals(actual: FieldValue | undefined, expected: ConditionScalar): boolean {
  if (expected === null) return isEmptyValue(actual);
  return !Array.isArray(actual) && actual === expected;
}

function isIn(actual: FieldValue | undefined, values: readonly ConditionScalar[]): boolean {
  if (Array.isArray(actual))
    return values.some((v) => typeof v === 'string' && (actual as readonly unknown[]).includes(v));
  return values.some((v) => equals(actual, v));
}

function evaluate(condition: Condition, context: ConditionContext, depth: number): boolean {
  if (depth > MAX_CONDITION_DEPTH) return false;

  switch (condition.op) {
    case 'eq':
      return equals(lookup(context, condition.field), condition.value);
    case 'neq':
      return !equals(lookup(context, condition.field), condition.value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const cmp = compareScalars(lookup(context, condition.field), condition.value);
      if (cmp === null) return false;
      return condition.op === 'gt'
        ? cmp > 0
        : condition.op === 'gte'
          ? cmp >= 0
          : condition.op === 'lt'
            ? cmp < 0
            : cmp <= 0;
    }
    case 'in':
      return isIn(lookup(context, condition.field), condition.values);
    case 'nin':
      return !isIn(lookup(context, condition.field), condition.values);
    case 'empty':
      return isEmptyValue(lookup(context, condition.field));
    case 'notEmpty':
      return !isEmptyValue(lookup(context, condition.field));
    case 'and':
      return condition.conditions.every((c) => evaluate(c, context, depth + 1));
    case 'or':
      return condition.conditions.some((c) => evaluate(c, context, depth + 1));
    case 'not':
      return !evaluate(condition.condition, context, depth + 1);
  }
}

export function evaluateCondition(condition: Condition, context: ConditionContext): boolean {
  return evaluate(condition, context, 1);
}

/** Campos (e `status`) de que a condição depende. Serve para reavaliar só o necessário. */
export function conditionFields(condition: Condition): ReadonlySet<string> {
  const fields = new Set<string>();
  const visit = (c: Condition): void => {
    switch (c.op) {
      case 'and':
      case 'or':
        c.conditions.forEach(visit);
        break;
      case 'not':
        visit(c.condition);
        break;
      default:
        fields.add(c.field);
    }
  };
  visit(condition);
  return fields;
}

export function conditionDepth(condition: Condition): number {
  switch (condition.op) {
    case 'and':
    case 'or':
      return 1 + Math.max(0, ...condition.conditions.map(conditionDepth));
    case 'not':
      return 1 + conditionDepth(condition.condition);
    default:
      return 1;
  }
}
