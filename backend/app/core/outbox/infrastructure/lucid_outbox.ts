import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import { checkEvent, type OutboxEvent } from '#core/outbox/domain/event'
import type { OutboxWriter } from '#core/outbox/application/ports'

export class LucidOutboxWriter implements OutboxWriter {
  async append(scope: TenantScope, event: OutboxEvent): Promise<void> {
    const problem = checkEvent(event)
    if (problem) throw new Error(problem)
    const { trx, context } = scope as LucidTenantScope
    await trx.rawQuery(
      `insert into outbox_events
         (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload, correlation_id,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)`,
      [
        context.tenantId,
        event.aggregateType,
        event.aggregateId,
        event.aggregateVersion,
        event.eventType,
        JSON.stringify(event.payload),
        event.correlationId as never,
        context.membershipId as never,
        context.membershipId as never,
      ]
    )
  }
}
