/** API pública do outbox transaccional. Outros módulos importam **apenas** daqui. */
export { checkEvent, type OutboxEvent } from '#core/outbox/domain/event'
export type { OutboxWriter } from '#core/outbox/application/ports'
export { LucidOutboxWriter } from '#core/outbox/infrastructure/lucid_outbox'
