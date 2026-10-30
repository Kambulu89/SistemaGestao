import type { ApiError } from '../../api/api-error.model';
import type { DefinitionFailure } from '../data-access/custom-field.gateway';
import type { DefinitionIssue } from '../engine/definition-integrity';
import type { RecordValidationFailure, ValidationIssue } from '../models/validation-issue.model';
import { fieldKeyOf } from './dynamic-mapper';

/** Falha num rascunho ou na publicação: o formato (`details.issues`) que o designer sabe mostrar. */
export function toDefinitionFailure(
  error: ApiError,
  fieldKeyAt: (index: number) => string | undefined,
): ApiError {
  if (
    error.status !== 422 &&
    error.code !== 'INCOMPATIBLE_SCHEMA' &&
    error.code !== 'ENTITY_IN_USE'
  )
    return error;
  const issues: DefinitionIssue[] = (error.fieldErrors ?? []).map((d) => {
    const indexed = /^fields\[(\d+)\]\.?(.*)$/.exec(d.path);
    if (indexed) {
      const key = fieldKeyAt(Number(indexed[1]));
      return { severity: 'error', path: `fields.${key ?? indexed[1]}`, message: d.message };
    }
    const byCode = /^fields\.([a-z0-9_]+)$/.exec(d.path);
    if (byCode)
      return { severity: 'error', path: `fields.${fieldKeyOf(byCode[1]!)}`, message: d.message };
    const path = d.path === 'code' ? 'key' : d.path === 'name' ? 'names' : d.path;
    return { severity: 'error', path, message: d.message };
  });
  if (issues.length === 0) issues.push({ severity: 'error', path: 'key', message: error.message });
  return {
    ...error,
    status: 422,
    details: { issues } satisfies DefinitionFailure,
  };
}

const RULE_OF: Readonly<Record<string, ValidationIssue['rule']>> = {
  REQUIRED: 'required',
  UNIQUE: 'unique',
  TOO_SHORT: 'minLength',
  TOO_LONG: 'maxLength',
  TOO_SMALL: 'min',
  TOO_LARGE: 'max',
  PATTERN_MISMATCH: 'pattern',
};

/** Falha ao gravar um registo: um problema por campo, no formato dos formulários. */
export function toRecordFailure(error: ApiError): ApiError {
  const unique = error.code === 'UNIQUE_VALUE_TAKEN';
  if (error.status !== 422 && !unique) return error;
  const issues: ValidationIssue[] = (error.fieldErrors ?? []).map((d) => {
    const field = /^data\.([a-z0-9_]+)$/.exec(d.path);
    return {
      fieldKey: field ? fieldKeyOf(field[1]!) : null,
      rule: RULE_OF[d.code] ?? 'server',
      message: d.message,
    };
  });
  if (issues.length === 0) issues.push({ fieldKey: null, rule: 'server', message: error.message });
  return { ...error, status: 422, details: { issues } satisfies RecordValidationFailure };
}
