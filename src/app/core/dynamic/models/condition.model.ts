export type ConditionScalar = string | number | boolean | null;

/**
 * Condição declarativa. É dados, não código: o tenant nunca fornece expressões executáveis.
 * `field` refere uma chave de campo ou a chave de sistema `status`.
 */
export type Condition =
  | {
      readonly op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
      readonly field: string;
      readonly value: ConditionScalar;
    }
  | {
      readonly op: 'in' | 'nin';
      readonly field: string;
      readonly values: readonly ConditionScalar[];
    }
  | { readonly op: 'empty' | 'notEmpty'; readonly field: string }
  | { readonly op: 'and' | 'or'; readonly conditions: readonly Condition[] }
  | { readonly op: 'not'; readonly condition: Condition };

/** Chave de sistema que aponta para o estado do registo. */
export const STATUS_KEY = 'status';
