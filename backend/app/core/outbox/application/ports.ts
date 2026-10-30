import type { TenantScope } from '#core/tenancy/index'
import type { OutboxEvent } from '#core/outbox/domain/event'

/** Escreve um evento **na transacção do `scope`**: se a transacção falhar, o evento também não existe. */
export interface OutboxWriter {
  append(scope: TenantScope, event: OutboxEvent): Promise<void>
}

/** Um evento lido do outbox por um consumidor. */
export interface StoredOutboxEvent {
  id: string
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  eventType: string
  payload: Record<string, unknown>
  correlationId: string | null
  createdAt: Date
  /** Execução de automação que o originou (`null`: acção de uma pessoa) e a profundidade da cadeia. */
  causationRunId: string | null
  causationDepth: number
}

/**
 * Consumo do outbox com inbox: cada consumidor recebe cada evento **uma só vez** (a entrega regista-se na mesma
 * transacção em que o consumidor fez o seu trabalho). Lê por ordem de criação sem cursor, porque transacções
 * concorrentes podem confirmar fora de ordem e um cursor saltaria eventos.
 */
export interface OutboxReader {
  /** Eventos ainda não entregues a `consumer`, do mais antigo para o mais recente. */
  undelivered(scope: TenantScope, consumer: string, limit: number): Promise<StoredOutboxEvent[]>
  markDelivered(scope: TenantScope, consumer: string, eventId: string): Promise<void>
}
