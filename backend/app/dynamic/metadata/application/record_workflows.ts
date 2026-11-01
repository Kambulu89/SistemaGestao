import type { TenantScope } from '#core/tenancy/index'

/**
 * Porta dos workflows de aprovação (C14) nas escritas dos registos. O módulo de metadados não conhece os workflows:
 * chama esta porta, que o módulo `workflows` regista no arranque (`start/dynamic.ts`). Sem registo, as escritas
 * **falham** (falha fechada), em vez de deixar uma aprovação valer para valores que ela não viu.
 */
export interface RecordWorkflows {
  /**
   * Na transacção que altera ou arquiva o registo: cancela os processos de aprovação em curso, porque os valores já não
   * são os que foram submetidos.
   */
  onChanged(scope: TenantScope, recordId: string): Promise<void>
}

let registered: RecordWorkflows | undefined

export function registerRecordWorkflows(workflows: RecordWorkflows): void {
  registered = workflows
}

export function currentRecordWorkflows(): RecordWorkflows {
  if (!registered) throw new Error('Os workflows não foram registados (start/dynamic).')
  return registered
}
