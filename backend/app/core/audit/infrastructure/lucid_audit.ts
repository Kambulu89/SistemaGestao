import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import { redactSecrets } from '#core/audit/domain/redaction'
import type {
  SecurityEventInput,
  SecurityEventView,
  Severity,
} from '#core/audit/domain/security_event'
import type { AuditEntry, AuditFilter, SecurityEventLog } from '#core/audit/application/ports'

const conn = () => db.connection('runtime')

/** Grava em `security_events` (só INSERT). Redige os metadados e engole falhas (com um aviso, sem dados). */
export class LucidSecurityEventLog implements SecurityEventLog {
  async record(event: SecurityEventInput) {
    try {
      await conn()
        .table('security_events')
        .insert({
          tenant_id: event.tenantId ?? null,
          user_id: event.userId ?? null,
          event_type: event.type,
          severity: event.severity,
          metadata: JSON.stringify(redactSecrets(event.metadata ?? {})),
        })
    } catch (error) {
      logger.warn(
        { err: (error as Error).message, type: event.type },
        'Falha ao registar evento de segurança'
      )
    }
  }
}

interface AuditRow {
  id: string
  occurred_at: Date
  action: string
  resource_type: string
  resource_id: string | null
  actor_type: AuditEntry['actorType']
  actor_user_id: string | null
  actor_membership_id: string | null
  before_data: Record<string, unknown> | null
  after_data: Record<string, unknown> | null
  reason: string | null
  ip: string | null
  correlation_id: string | null
}

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId

export class LucidAuditReader {
  /** A RLS limita ao tenant; o filtro explícito repete-o. */
  async list(scope: TenantScope, filter: AuditFilter): Promise<AuditEntry[]> {
    if (filter.allowedResourceTypes.length === 0) return []
    const query = trxOf(scope)
      .from('audit_logs')
      .where('tenant_id', tenantOf(scope))
      .whereIn('resource_type', [...filter.allowedResourceTypes])
      .orderBy([
        { column: 'occurred_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(filter.limit)
      .offset(filter.offset)
    if (filter.from) query.where('occurred_at', '>=', filter.from)
    if (filter.to) query.where('occurred_at', '<=', filter.to)
    if (filter.resourceType) query.where('resource_type', filter.resourceType)
    if (filter.resourceId) query.where('resource_id', filter.resourceId)
    if (filter.action) query.where('action', filter.action)
    if (filter.actorMembershipId) query.where('actor_membership_id', filter.actorMembershipId)
    const rows = (await query) as AuditRow[]
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      actorType: r.actor_type,
      actorUserId: r.actor_user_id,
      actorMembershipId: r.actor_membership_id,
      before: r.before_data,
      after: r.after_data,
      reason: r.reason,
      ip: r.ip,
      correlationId: r.correlation_id,
    }))
  }
}

interface EventRow {
  id: string
  tenant_id: string | null
  user_id: string | null
  event_type: string
  severity: Severity
  metadata: Record<string, unknown>
  occurred_at: Date
}

const toEvent = (r: EventRow): SecurityEventView => ({
  id: r.id,
  type: r.event_type,
  severity: r.severity,
  tenantId: r.tenant_id,
  userId: r.user_id,
  metadata: r.metadata,
  occurredAt: r.occurred_at,
})

export class LucidSecurityEventReader {
  /** Eventos do tenant do contexto. A tabela é global (sem RLS): o filtro por tenant é obrigatório aqui. */
  async listForTenant(
    scope: TenantScope,
    limit: number,
    offset: number
  ): Promise<SecurityEventView[]> {
    const rows = await trxOf(scope)
      .from('security_events')
      .where('tenant_id', tenantOf(scope))
      .orderBy([
        { column: 'occurred_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit)
      .offset(offset)
    return (rows as EventRow[]).map(toEvent)
  }

  /** Actividade da própria conta (o utilizador vê os seus eventos, não os de outros). */
  async listForUser(userId: string, limit: number): Promise<SecurityEventView[]> {
    const rows = await conn()
      .from('security_events')
      .where('user_id', userId)
      .orderBy([
        { column: 'occurred_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit)
    return (rows as EventRow[]).map(toEvent)
  }
}
