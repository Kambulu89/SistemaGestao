import type { TenantContext } from '#core/tenancy/index'
import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'
import type { RecordValues } from '#dynamic/metadata/domain/record'

/** O que as regras precisam de saber de uma escrita de registo (já validada e com as fórmulas calculadas). */
export interface RecordRuleCheck {
  entity: { id: string; code: string }
  operation: 'CREATE' | 'UPDATE'
  recordId: string | null
  fields: readonly FieldSpec[]
  values: RecordValues
}

/**
 * Porta das regras de negócio (C12) sobre as escritas de registos. O módulo de regras regista a sua
 * implementação no arranque (`start/dynamic.ts`); os metadados não dependem dele. Devolve os problemas que
 * **bloqueiam** a escrita.
 */
export interface RecordRules {
  check(context: TenantContext, input: RecordRuleCheck): Promise<Issue[]>
}

let registered: RecordRules | null = null

export function registerRecordRules(rules: RecordRules): void {
  registered = rules
}

/**
 * Falha fechada: sem regras registadas não se escreve (nunca se ignoram regras em silêncio). Só acontece se o
 * arranque não correr `start/dynamic.ts`.
 */
export function currentRecordRules(): RecordRules {
  if (!registered) throw new Error('As regras de negócio não foram registadas no arranque.')
  return registered
}
