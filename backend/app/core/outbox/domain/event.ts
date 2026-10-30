/**
 * Evento de domínio a publicar (outbox). Escreve-se na mesma transacção da alteração que o originou; o consumidor
 * deve ser idempotente (entrega pelo menos uma vez) e pode ordenar por `aggregateVersion` quando a ordem importa.
 */
export interface OutboxEvent {
  aggregateType: string
  aggregateId: string
  /** Versão do agregado depois da alteração (permite ordenar os efeitos). */
  aggregateVersion: number
  eventType: string
  /** Só dados necessários ao consumidor; nunca valores sensíveis. */
  payload: Record<string, unknown>
  correlationId: string | null
}

export const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/

/** `null` se o evento é válido; senão, o motivo. */
export function checkEvent(event: OutboxEvent): string | null {
  if (!EVENT_TYPE.test(event.eventType))
    return 'Tipo de evento inválido (ex.: dynamic.record.state_changed).'
  if (!event.aggregateType || event.aggregateType.length > 60) return 'Tipo de agregado inválido.'
  if (!Number.isInteger(event.aggregateVersion) || event.aggregateVersion < 1) {
    return 'Versão do agregado inválida.'
  }
  return null
}
