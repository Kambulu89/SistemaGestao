import type { SecurityEventInput } from '#core/audit/domain/security_event'

/** Regista um evento de segurança. Nunca lança: a falha a auditar não pode derrubar o pedido. */
export interface SecurityEventLog {
  record(event: SecurityEventInput): Promise<void>
}

export interface AuditFilter {
  from?: Date
  to?: Date
  resourceType?: string
  resourceId?: string
  action?: string
  actorMembershipId?: string
  /** Tipos de recurso que o actor pode ler (a RBAC já foi decidida antes da consulta). */
  allowedResourceTypes: readonly string[]
  limit: number
  offset: number
}

export interface AuditEntry {
  id: string
  occurredAt: Date
  action: string
  resourceType: string
  resourceId: string | null
  actorType: 'USER' | 'SERVICE' | 'SUPPORT'
  actorUserId: string | null
  actorMembershipId: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reason: string | null
  ip: string | null
  correlationId: string | null
}
