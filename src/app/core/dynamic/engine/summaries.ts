import type { Condition, ConditionScalar } from '../models/condition.model';
import { STATUS_KEY } from '../models/condition.model';
import type { EntityDefinition } from '../models/entity-definition.model';
import { hasOptions, type FieldType } from '../models/field-definition.model';
import { FIELD_TYPE_CATALOG } from './field-types';
import type { CompareOperator, ValidationRule } from '../models/validation-rule.model';

/** Rótulos dos tipos, derivados do catálogo de tipos (única fonte de verdade). */
export const FIELD_TYPE_LABELS = Object.fromEntries(
  FIELD_TYPE_CATALOG.map((t) => [t.type, t.label]),
) as Record<FieldType, string>;

const OPERATOR_SYMBOLS = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' } as const;
const COMPARE_TEXT: Record<CompareOperator, string> = {
  eq: 'igual a',
  neq: 'diferente de',
  gt: 'superior a',
  gte: 'igual ou superior a',
  lt: 'inferior a',
  lte: 'igual ou inferior a',
};

function fieldLabel(entity: EntityDefinition, key: string): string {
  return key === STATUS_KEY ? 'Estado' : (entity.fields.find((f) => f.key === key)?.label ?? key);
}

/** Rótulo de um valor de uma condição: o da opção ou do estado, quando existe. */
function valueLabel(entity: EntityDefinition, key: string, value: ConditionScalar): string {
  if (value === null) return 'vazio';
  if (key === STATUS_KEY)
    return entity.statuses.find((s) => s.code === value)?.name ?? String(value);
  const field = entity.fields.find((f) => f.key === key);
  if (field && hasOptions(field))
    return field.options.find((o) => o.value === value)?.label ?? String(value);
  return typeof value === 'boolean' ? (value ? 'Sim' : 'Não') : String(value);
}

/** Texto legível de uma condição declarativa, ex.: "Categoria em (C, D) e Estado = Inactiva". */
export function describeCondition(entity: EntityDefinition, condition: Condition): string {
  switch (condition.op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return `${fieldLabel(entity, condition.field)} ${OPERATOR_SYMBOLS[condition.op]} ${valueLabel(entity, condition.field, condition.value)}`;
    case 'in':
    case 'nin': {
      const values = condition.values.map((v) => valueLabel(entity, condition.field, v)).join(', ');
      return `${fieldLabel(entity, condition.field)} ${condition.op === 'in' ? 'em' : 'fora de'} (${values})`;
    }
    case 'empty':
      return `${fieldLabel(entity, condition.field)} vazio`;
    case 'notEmpty':
      return `${fieldLabel(entity, condition.field)} preenchido`;
    case 'and':
    case 'or': {
      const separator = condition.op === 'and' ? ' e ' : ' ou ';
      return condition.conditions
        .map((c) =>
          c.op === 'and' || c.op === 'or'
            ? `(${describeCondition(entity, c)})`
            : describeCondition(entity, c),
        )
        .join(separator);
    }
    case 'not':
      return `não (${describeCondition(entity, condition.condition)})`;
  }
}

/** Texto legível de uma regra de validação, incluindo a condição em que se aplica. */
export function describeRule(entity: EntityDefinition, rule: ValidationRule): string {
  const base = ((): string => {
    switch (rule.type) {
      case 'required':
        return 'Obrigatório';
      case 'minLength':
        return `Mínimo de ${rule.value} caracteres`;
      case 'maxLength':
        return `Máximo de ${rule.value} caracteres`;
      case 'min':
        return `Valor mínimo ${rule.value}`;
      case 'max':
        return `Valor máximo ${rule.value}`;
      case 'pattern':
        return `Segue o padrão /${rule.pattern}/`;
      case 'email':
        return 'Email válido';
      case 'unique':
        return 'Único por tenant (verificado no servidor)';
      case 'compare':
        return `${COMPARE_TEXT[rule.operator]} "${fieldLabel(entity, rule.otherField)}"`;
    }
  })();
  return rule.when ? `${base}, quando ${describeCondition(entity, rule.when)}` : base;
}
