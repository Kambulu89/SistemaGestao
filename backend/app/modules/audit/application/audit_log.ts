import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { ApiError } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { redact, type AuditActor, type AuditInput } from '#modules/audit/domain/audit'

/** Grava um evento na transacção indicada (RLS já com o tenant definido). */
export async function writeAudit(
  trx: TransactionClientContract,
  actor: AuditActor,
  event: AuditInput
) {
  await trx.rawQuery(
    `insert into audit_events (tenant_id, created_by, updated_by, actor_user_id, actor_membership_id, request_id,
                               action, entity_type, entity_id, changes, metadata)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
    [
      actor.tenantId,
      actor.userId,
      actor.userId,
      actor.userId,
      actor.membershipId,
      actor.requestId?.slice(0, 64) ?? null,
      event.action,
      event.entityType,
      event.entityId ?? null,
      event.changes ? JSON.stringify(redact(event.changes)) : null,
      event.metadata ? JSON.stringify(redact(event.metadata)) : null,
    ] as never[]
  )
}

/** Audita na transacção de tenant em curso, com o actor do contexto (servidor), nunca um actor vindo do pedido. */
export function audit(scope: TenantScope, event: AuditInput) {
  const { tenantId, userId, membershipId, requestId } = scope.context
  return writeAudit(scope.trx, { tenantId, userId, membershipId, requestId }, event)
}

export interface AuditEventView {
  id: string
  occurredAt: string
  action: string
  entityType: string
  entityId: string | null
  changes: unknown
  metadata: unknown
  requestId: string | null
  actor: {
    userId: string
    membershipId: string | null
    fullName: string | null
    email: string
  } | null
}

export interface AuditFilter {
  action?: string
  entityType?: string
  entityId?: string
  actorUserId?: string
  from?: Date
  to?: Date
  limit: number
  offset: number
}

/** Consulta (só leitura) da auditoria da empresa em contexto, mais recente primeiro. */
export function listAuditEvents(context: TenantContext, filter: AuditFilter) {
  if (filter.from && filter.to && filter.from > filter.to) {
    throw ApiError.validation([
      { path: 'to', code: 'RANGE', message: 'O fim tem de ser posterior ao início.' },
    ])
  }
  return runInTenant(context, async ({ trx }) => {
    const where = ['e.tenant_id = ?']
    const params: unknown[] = [context.tenantId]
    const eq = (column: string, value: unknown) => {
      if (value === undefined) return
      where.push(`${column} = ?`)
      params.push(value)
    }
    eq('e.entity_type', filter.entityType)
    eq('e.entity_id', filter.entityId)
    eq('e.actor_user_id', filter.actorUserId)
    if (filter.action) {
      // `member.*` → prefixo; caso contrário igualdade.
      if (filter.action.endsWith('.*')) {
        where.push('e.action like ?')
        params.push(`${filter.action.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      } else eq('e.action', filter.action)
    }
    if (filter.from) {
      where.push('e.occurred_at >= ?')
      params.push(filter.from)
    }
    if (filter.to) {
      where.push('e.occurred_at <= ?')
      params.push(filter.to)
    }
    const clause = where.join(' and ')
    const rows = await trx.rawQuery(
      `select e.id, e.occurred_at, e.action, e.entity_type, e.entity_id, e.changes, e.metadata, e.request_id,
              e.actor_user_id, e.actor_membership_id, u.full_name, u.email
         from audit_events e left join users u on u.id = e.actor_user_id
        where ${clause} order by e.occurred_at desc, e.id desc limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trx.rawQuery(
      `select count(*)::int as total from audit_events e where ${clause}`,
      params as never[]
    )
    const items: AuditEventView[] = (rows.rows as any[]).map((r) => ({
      id: r.id,
      occurredAt: new Date(r.occurred_at).toISOString(),
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      changes: r.changes,
      metadata: r.metadata,
      requestId: r.request_id,
      actor: r.actor_user_id
        ? {
            userId: r.actor_user_id,
            membershipId: r.actor_membership_id,
            fullName: r.full_name,
            email: r.email,
          }
        : null,
    }))
    return { items, total: (count.rows[0] as { total: number }).total }
  })
}
