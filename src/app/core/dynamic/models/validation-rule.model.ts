import type { Condition } from './condition.model';

export type CompareOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

/** Propriedades comuns: mensagem própria e condição para a regra se aplicar. */
interface RuleBase {
  readonly id?: string;
  readonly message?: string;
  /** A regra só é avaliada quando a condição se verifica. */
  readonly when?: Condition;
}

/**
 * Regra de validação declarativa. A interpretação é feita pelo motor (`validation.ts`);
 * nunca se executa código do tenant.
 */
export type ValidationRule = RuleBase &
  (
    | { readonly type: 'required' }
    | { readonly type: 'minLength'; readonly value: number }
    | { readonly type: 'maxLength'; readonly value: number }
    | { readonly type: 'min'; readonly value: number }
    | { readonly type: 'max'; readonly value: number }
    | { readonly type: 'pattern'; readonly pattern: string; readonly ignoreCase?: boolean }
    | { readonly type: 'email' }
    /** Depende de todos os registos do tenant: só o backend a consegue decidir. */
    | { readonly type: 'unique' }
    | {
        readonly type: 'compare';
        readonly operator: CompareOperator;
        readonly otherField: string;
      }
  );

export type ValidationRuleType = ValidationRule['type'];

/** Regra ao nível da entidade, anexada a um campo (típico das comparações entre campos). */
export type EntityValidationRule = ValidationRule & { readonly field: string };
