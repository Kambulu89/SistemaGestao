import { runInTenant, MembershipRepository, type TenantContext } from '#modules/tenancy/index'
import { effectivePermissions, RoleService } from '#modules/rbac/index'
import { entitlementsFor } from '#modules/subscription/index'
import { organizationCounts, searchOrganization } from '#modules/organization/index'
import { approvalStats, searchApprovals } from '#modules/approvals/index'
import { storageUsedBytes } from '#modules/attachments/index'
import { listAuditEvents } from '#modules/audit/index'

/**
 * Painel e pesquisa global: só compõem dados que os módulos donos expõem, na empresa em contexto e com as mesmas
 * permissões e funcionalidades das rotas de cada módulo. Uma secção sem acesso vem `null` (a interface diz "sem
 * acesso"); nunca se calcula nada que o membro não pudesse ver noutra rota.
 */
const memberships = new MembershipRepository()
const roles = new RoleService()

export async function dashboardSummary(context: TenantContext) {
  const { status, features } = await entitlementsFor(context.tenantId)
  const enabled = (code: string) => features.get(code)?.enabled === true
  const limitOf = (code: string) => features.get(code)?.limit ?? null

  const base = await runInTenant(context, async (scope) => {
    const held = (await effectivePermissions(scope)).tenant
    const members = held.has('members.read') ? await memberships.countsByStatus(scope) : null
    const organization =
      held.has('organization.read') && enabled('organization')
        ? await organizationCounts(scope)
        : null
    const approvals = enabled('approvals') ? await approvalStats(scope) : null
    const usage = held.has('subscription.read')
      ? {
          members: {
            used: Object.entries(await memberships.countsByStatus(scope))
              .filter(([s]) => s !== 'REVOKED')
              .reduce((sum, [, n]) => sum + n, 0),
            limit: limitOf('members.max'),
            enabled: enabled('members.max'),
          },
          legalEntities: {
            used: (await organizationCounts(scope)).legalEntities,
            limit: limitOf('legal_entities.max'),
            enabled: enabled('legal_entities.max'),
          },
          storageMb: {
            used: Math.round(((await storageUsedBytes(scope)) / 1024 / 1024) * 10) / 10,
            limit: limitOf('attachments.storage_mb'),
            enabled: enabled('attachments.storage_mb'),
          },
        }
      : null
    return { held, members, organization, approvals, usage }
  })

  const activity = base.held.has('audit.read')
    ? (await listAuditEvents(context, { limit: 8, offset: 0 })).items.map((e) => ({
        id: e.id,
        occurredAt: e.occurredAt,
        action: e.action,
        entityType: e.entityType,
        actor: e.actor?.fullName ?? e.actor?.email ?? null,
      }))
    : null

  return {
    subscriptionStatus: status,
    members: base.members,
    organization: base.organization,
    approvals: base.approvals,
    usage: base.usage,
    activity,
  }
}

export interface SearchHit {
  type: 'organization' | 'member' | 'role' | 'approval_request' | 'approval_workflow'
  kind?: string
  id: string
  title: string
  subtitle: string | null
}

/** Pesquisa global (até 5 por tipo): só as fontes que o membro pode ler e que a empresa contratou. */
export async function globalSearch(context: TenantContext, q: string): Promise<SearchHit[]> {
  const LIMIT = 5
  const { features } = await entitlementsFor(context.tenantId)
  const enabled = (code: string) => features.get(code)?.enabled === true
  return runInTenant(context, async (scope) => {
    const held = (await effectivePermissions(scope)).tenant
    const hits: SearchHit[] = []
    if (held.has('organization.read') && enabled('organization'))
      for (const r of await searchOrganization(scope, q, LIMIT))
        hits.push({
          type: 'organization',
          kind: r.kind,
          id: r.id,
          title: r.title,
          subtitle: r.subtitle,
        })
    if (held.has('members.read'))
      for (const m of (await memberships.list(scope, { q, limit: LIMIT, offset: 0 })).items)
        hits.push({ type: 'member', id: m.id, title: m.fullName, subtitle: m.email })
    if (held.has('roles.read')) {
      const needle = q.toLowerCase()
      for (const r of (await roles.list(context))
        .filter((x) => x.name.toLowerCase().includes(needle) || x.code.includes(needle))
        .slice(0, LIMIT))
        hits.push({ type: 'role', id: r.id, title: r.name, subtitle: r.code })
    }
    if (enabled('approvals')) {
      const found = await searchApprovals(scope, q, LIMIT)
      for (const r of found.requests)
        hits.push({ type: 'approval_request', id: r.id, title: r.title, subtitle: r.status })
      for (const w of found.workflows)
        hits.push({ type: 'approval_workflow', id: w.id, title: w.title, subtitle: w.status })
    }
    return hits
  })
}
