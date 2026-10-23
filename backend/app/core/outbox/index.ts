/** API pública do outbox transaccional. Outros módulos importam **apenas** daqui. */
export { checkEvent, type OutboxEvent } from '#core/outbox/domain/event'
export { currentCausation, runWithCausation, type Causation } from '#core/outbox/domain/causation'
export type { OutboxReader, OutboxWriter, StoredOutboxEvent } from '#core/outbox/application/ports'
export { LucidOutboxReader, LucidOutboxWriter } from '#core/outbox/infrastructure/lucid_outbox'
