import type { CompareOperator, ValidationRule } from '../models/validation-rule.model';
import type { EntityDefinition } from '../models/entity-definition.model';
import type { FieldDefinition, FieldValue } from '../models/field-definition.model';
import type { FormMode } from '../models/form-definition.model';
import type { ValidationIssue } from '../models/validation-issue.model';
import {
  type ConditionContext,
  compareScalars,
  evaluateCondition,
  isEmptyValue,
} from './condition';
import { FULL_ACCESS, type FieldAccess, resolveFieldState } from './field-state';

/** `unique` e semelhantes dependem de dados que o frontend não tem: decide o backend. */
export function ruleRuntime(rule: ValidationRule): 'client' | 'server' {
  return rule.type === 'unique' ? 'server' : 'client';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;

const MAX_PATTERN_LENGTH = 256;
const MAX_TESTED_LENGTH = 2048;
/** Grupo com quantificador dentro seguido de outro quantificador (ex.: `(a+)+`): risco de ReDoS. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*{]/;

/**
 * Compila um padrão fornecido por um tenant, recusando os que são longos demais ou sabidamente
 * perigosos. É uma defesa em profundidade: o backend deve usar um motor sem retrocesso (ex.: RE2).
 */
export function safeRegExp(pattern: string, ignoreCase = false): RegExp | null {
  if (
    pattern.length === 0 ||
    pattern.length > MAX_PATTERN_LENGTH ||
    NESTED_QUANTIFIER.test(pattern)
  ) {
    return null;
  }
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch {
    return null;
  }
}

/** Regras do campo: as suas, as da entidade que o visam e as implícitas do tipo (email, telefone). */
export function rulesForField(
  entity: EntityDefinition,
  field: FieldDefinition,
): readonly ValidationRule[] {
  const rules: ValidationRule[] = [
    ...field.validations,
    ...entity.rules.filter((r) => r.field === field.key),
  ];
  if (field.type === 'email' && !rules.some((r) => r.type === 'email'))
    rules.push({ type: 'email' });
  if (field.type === 'phone' && !rules.some((r) => r.type === 'pattern')) {
    rules.push({
      type: 'pattern',
      pattern: PHONE.source,
      message: 'Introduza um número de telefone válido.',
    });
  }
  return rules;
}

const OPERATOR_TEXT: Record<CompareOperator, string> = {
  eq: 'igual a',
  neq: 'diferente de',
  gt: 'superior a',
  gte: 'igual ou superior a',
  lt: 'inferior a',
  lte: 'igual ou inferior a',
};

function compareHolds(operator: CompareOperator, cmp: number): boolean {
  switch (operator) {
    case 'eq':
      return cmp === 0;
    case 'neq':
      return cmp !== 0;
    case 'gt':
      return cmp > 0;
    case 'gte':
      return cmp >= 0;
    case 'lt':
      return cmp < 0;
    case 'lte':
      return cmp <= 0;
  }
}

export interface ValidateFieldOptions {
  /** Obrigatoriedade já resolvida (estática ou condicional). */
  readonly required: boolean;
}

/** Valida um valor contra as regras executáveis no frontend. Regras de servidor são ignoradas. */
export function validateField(
  entity: EntityDefinition,
  field: FieldDefinition,
  value: FieldValue | undefined,
  context: ConditionContext,
  options: ValidateFieldOptions,
): ValidationIssue[] {
  const applicable = rulesForField(entity, field).filter(
    (r) => ruleRuntime(r) === 'client' && (!r.when || evaluateCondition(r.when, context)),
  );
  const issue = (rule: ValidationRule, fallback: string): ValidationIssue => ({
    fieldKey: field.key,
    rule: rule.type,
    message: rule.message ?? fallback,
  });

  if (isEmptyValue(value)) {
    const explicit = applicable.find((r) => r.type === 'required');
    if (options.required || explicit) {
      return [
        {
          fieldKey: field.key,
          rule: 'required',
          message: explicit?.message ?? 'Campo obrigatório.',
        },
      ];
    }
    return [];
  }

  const issues: ValidationIssue[] = [];
  for (const rule of applicable) {
    switch (rule.type) {
      case 'minLength':
        if ((typeof value === 'string' || Array.isArray(value)) && value.length < rule.value) {
          issues.push(issue(rule, `Mínimo de ${rule.value} caracteres.`));
        }
        break;
      case 'maxLength':
        if ((typeof value === 'string' || Array.isArray(value)) && value.length > rule.value) {
          issues.push(issue(rule, `Máximo de ${rule.value} caracteres.`));
        }
        break;
      case 'min':
        if (typeof value === 'number' && value < rule.value)
          issues.push(issue(rule, `O valor mínimo é ${rule.value}.`));
        break;
      case 'max':
        if (typeof value === 'number' && value > rule.value)
          issues.push(issue(rule, `O valor máximo é ${rule.value}.`));
        break;
      case 'pattern': {
        if (typeof value !== 'string') break;
        const regexp = safeRegExp(rule.pattern, rule.ignoreCase);
        // Padrão inválido ou perigoso: não se avalia no cliente (a definição não deveria ter sido publicada).
        if (regexp && (value.length > MAX_TESTED_LENGTH || !regexp.test(value))) {
          issues.push(issue(rule, 'Formato inválido.'));
        }
        break;
      }
      case 'email':
        if (typeof value === 'string' && !EMAIL.test(value))
          issues.push(issue(rule, 'Introduza um email válido.'));
        break;
      case 'compare': {
        const other = context.values[rule.otherField];
        if (isEmptyValue(other)) break;
        const cmp = compareScalars(value, other);
        if (cmp !== null && !compareHolds(rule.operator, cmp)) {
          const otherLabel =
            entity.fields.find((f) => f.key === rule.otherField)?.label ?? rule.otherField;
          issues.push(issue(rule, `Tem de ser ${OPERATOR_TEXT[rule.operator]} "${otherLabel}".`));
        }
        break;
      }
      case 'required':
      case 'unique':
        break;
    }
  }
  return issues;
}

export interface ValidateRecordOptions {
  readonly mode: FormMode;
  readonly status?: string | null;
  readonly access?: FieldAccess;
}

/**
 * Valida os valores de um registo. Só se validam campos visíveis e editáveis: um campo escondido
 * ou só de leitura não pode ser corrigido pelo utilizador.
 */
export function validateRecordData(
  entity: EntityDefinition,
  values: Readonly<Record<string, FieldValue | undefined>>,
  options: ValidateRecordOptions,
): ValidationIssue[] {
  const context: ConditionContext = { values, status: options.status ?? null };
  const access = options.access ?? FULL_ACCESS;

  return entity.fields.flatMap((field) => {
    const state = resolveFieldState(field, context, options.mode, access);
    if (!state.visible || !state.editable) return [];
    return validateField(entity, field, values[field.key], context, { required: state.required });
  });
}
