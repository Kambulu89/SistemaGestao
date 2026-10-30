import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import { currentCausation } from '#core/outbox/domain/causation'
import { checkEvent, type OutboxEvent } from '#core/outbox/domain/event'
import type { OutboxReader, OutboxWriter, StoredOutboxEvent } from '#core/outbox/application/ports'

export class LucidOutboxWriter implements OutboxWriter {
  async append(scope: TenantScope, event: OutboxEvent): Promise<void> {
    const problem = checkEvent(event)
    if (problem) throw new Error(problem)
    const { trx, context } = scope as LucidTenantScope
    const causation = currentCausation()
    await trx.rawQuery(
      `insert into outbox_events
         (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload, correlation_id,
          causation_run_id, causation_depth, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`,
      [
        context.tenantId,
        event.aggregateType,
        event.aggregateId,
        event.aggregateVersion,
        event.eventType,
        JSON.stringify(event.payload),
        event.correlationId as never,
        (causation?.runId ?? null) as never,
        causation?.depth ?? 0,
        context.membershipId as never,
        context.membershipId as never,
      ]
    )
  }
}

interface EventRow {
  id: string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number
  event_type: string
  payload: Record<string, unknown>
  correlation_id: string | null
  created_at: Date
  causation_run_id: string | null
  causation_depth: number
}

export class LucidOutboxReader implements OutboxReader {
  async undelivered(scope: TenantScope, consumer: string, limit: number) {
    const { trx, context } = scope as LucidTenantScope
    const result = await trx.rawQuery(
      `select e.id, e.aggregate_type, e.aggregate_id, e.aggregate_version, e.event_type, e.payload,
              e.correlation_id, e.created_at, e.causation_run_id, e.causation_depth
         from outbox_events e
        where e.tenant_id = ?
          and not exists (select 1 from outbox_deliveries d
                           where d.tenant_id = e.tenant_id and d.consumer = ? and d.event_id = e.id)
        order by e.created_at, e.id
        limit ?`,
      [context.tenantId, consumer, limit]
    )
    return (result.rows as EventRow[]).map((r): StoredOutboxEvent => ({
      id: r.id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      aggregateVersion: r.aggregate_version,
      eventType: r.event_type,
      payload: r.payload,
      correlationId: r.correlation_id,
      createdAt: r.created_at,
      causationRunId: r.causation_run_id,
      causationDepth: r.causation_depth,
    }))
  }

  async markDelivered(scope: TenantScope, consumer: string, eventId: string) {
    const { trx, context } = scope as LucidTenantScope
    await trx.rawQuery(
      `insert into outbox_deliveries (tenant_id, consumer, event_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?)
       on conflict do nothing`,
      [
        context.tenantId,
        consumer,
        eventId,
        context.membershipId as never,
        context.membershipId as never,
      ]
    )
  }
}
