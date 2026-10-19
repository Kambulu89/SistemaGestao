import type { ValidationRuleType } from './validation-rule.model';

/** Problema de validação de um campo (ou do registo, com `fieldKey: null`). */
export interface ValidationIssue {
  readonly fieldKey: string | null;
  /** `type`: formato ou limite inerente ao tipo do campo (url, precisão, ficheiro…). */
  readonly rule: ValidationRuleType | 'server' | 'type';
  readonly message: string;
}

/** Corpo (`ApiError.details`) de uma resposta 422 do backend. */
export interface RecordValidationFailure {
  readonly issues: readonly ValidationIssue[];
}
