import type { TenantScope } from '#core/tenancy/index'
import type { OutboxEvent } from '#core/outbox/domain/event'

/** Escreve um evento **na transacção do `scope`**: se a transacção falhar, o evento também não existe. */
export interface OutboxWriter {
  append(scope: TenantScope, event: OutboxEvent): Promise<void>
}
