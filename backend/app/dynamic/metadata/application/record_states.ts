import type { TenantContext, TenantScope } from '#core/tenancy/index'

/** O estado de um registo, tal como o módulo de máquinas de estados o descreve (C13). */
export interface RecordState {
  code: string
  label: string
  category: 'INITIAL' | 'ACTIVE' | 'FINAL' | 'CANCELLED'
  /** `false`: o registo não aceita alterações de valores neste estado. */
  editable: boolean
  color: string | null
  machine: { code: string; revision: number }
  /** Versão de concorrência do estado (`expectedVersion` das transições). */
  version: number
}

export interface RecordStateTarget {
  id: string
  code: string
}

/**
 * Porta das máquinas de estados nos registos. O módulo de metadados não conhece as máquinas: chama esta porta, que o
 * módulo `states` regista no arranque (`start/dynamic.ts`). Sem registo, as escritas **falham** (falha fechada), em vez
 * de ignorar em silêncio os estados.
 */
export interface RecordStates {
  /** Na transacção da criação: dá ao registo novo o estado inicial da máquina em vigor (se a entidade a tiver). */
  onCreated(
    scope: TenantScope,
    context: TenantContext,
    entity: RecordStateTarget,
    recordId: string
  ): Promise<void>
  /** Na transacção da alteração: recusa (409) se o estado actual não admite alterações de valores. */
  assertEditable(scope: TenantScope, entity: RecordStateTarget, recordId: string): Promise<void>
  /** Estado de cada registo (os que não têm máquina ficam de fora). */
  describe(
    context: TenantContext,
    entity: RecordStateTarget,
    recordIds: readonly string[]
  ): Promise<Map<string, RecordState>>
}

let registered: RecordStates | undefined

export function registerRecordStates(states: RecordStates): void {
  registered = states
}

export function currentRecordStates(): RecordStates {
  if (!registered) throw new Error('As máquinas de estados não foram registadas (start/dynamic).')
  return registered
}
