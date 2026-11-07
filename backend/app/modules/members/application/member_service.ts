import { ApiError } from '#shared/http/api_error'
import { AccountService, type DeliveryStatus } from '#modules/identity/index'
import {
  MembershipRepository,
  runInTenant,
  TenantRepository,
  type Member,
  type MembershipStatus,
  type MemberSortField,
  type TenantContext,
} from '#modules/tenancy/index'
import { AssignmentService, type Assignment } from '#modules/rbac/index'
import { assertWithinLimit } from '#modules/subscription/index'
import { audit, writeAudit } from '#modules/audit/index'
import { tenantSettings } from '#modules/settings/index'

const memberships = new MembershipRepository()
const assignments = new AssignmentService()
const accounts = new AccountService()
const tenants = new TenantRepository()

export interface MemberView extends Member {
  roles: Pick<Assignment, 'id' | 'roleId' | 'roleCode' | 'scopeType' | 'scopeId'>[]
  /** Validade do convite pendente (só membros convidados). */
  invitationExpiresAt?: Date | null
}

async function withExpiry(views: MemberView[]) {
  const invited = views.filter((v) => v.status === 'INVITED').map((v) => v.id)
  const expiry = await accounts.invitationExpiry(invited)
  return views.map((v) =>
    v.status === 'INVITED' ? { ...v, invitationExpiresAt: expiry.get(v.id) ?? null } : v
  )
}

const withRoles = (member: Member, all: Assignment[]): MemberView => ({
  ...member,
  roles: all
    .filter((a) => a.membershipId === member.id)
    .map(({ id, roleId, roleCode, scopeType, scopeId }) => ({
      id,
      roleId,
      roleCode,
      scopeType,
      scopeId,
    })),
})

/** Membros da empresa: convites, aceitação, suspensão e perfis. As regras de perfis vivem no RBAC. */
export class MemberService {
  list(
    context: TenantContext,
    filter: {
      status?: MembershipStatus
      q?: string
      limit?: number
      offset?: number
      sort?: { field: MemberSortField; direction: 'asc' | 'desc' }
    }
  ) {
    return runInTenant(context, async (scope) => {
      const page = await memberships.list(scope, {
        ...filter,
        limit: Math.min(filter.limit ?? 50, 100),
        offset: filter.offset ?? 0,
      })
      const roles = await assignments.assignments(
        scope,
        page.items.map((m) => m.id)
      )
      return { items: page.items.map((m) => withRoles(m, roles)), total: page.total }
    }).then(async (page) => ({ ...page, items: await withExpiry(page.items) }))
  }

  get(context: TenantContext, id: string): Promise<MemberView> {
    return runInTenant(context, async (scope) => {
      const member = await memberships.find(scope, id)
      if (!member) throw ApiError.notFound()
      return withRoles(member, await assignments.assignments(scope, [id]))
    }).then(async (view) => (await withExpiry([view]))[0])
  }

  /**
   * Convida uma pessoa (conta global existente ou nova) com perfis iniciais. O token só é emitido depois de a
   * membership e os perfis ficarem gravados; a resposta diz se o email foi mesmo entregue.
   */
  async invite(
    context: TenantContext,
    input: {
      email: string
      fullName?: string | null
      roles?: { roleId: string; scopeType?: string; scopeId?: string | null }[]
    }
  ): Promise<{ member: MemberView; delivery: DeliveryStatus }> {
    const user = await accounts.findOrCreateForInvitation(input.email, input.fullName)
    let ttlDays = 7
    const membershipId = await runInTenant(context, async (scope) => {
      ttlDays = (await tenantSettings(scope)).invitationTtlDays
      // Limite contratado de membros: contam todos os que não foram revogados (convidados incluídos).
      await assertWithinLimit(scope.trx, context.tenantId, 'members.max', async () => {
        const r = await scope.trx.rawQuery(
          `select count(*)::int as n from tenant_memberships where tenant_id = ? and status <> 'REVOKED'`,
          [context.tenantId]
        )
        return (r.rows[0] as { n: number }).n
      })
      const id = await memberships.insertInvited(scope, user.id)
      for (const role of input.roles ?? [])
        await assignments.assign(
          scope,
          id,
          role.roleId,
          role.scopeType ?? 'TENANT',
          role.scopeId ?? null
        )
      await audit(scope, {
        action: 'member.invited',
        entityType: 'membership',
        entityId: id,
        metadata: { email: user.email, roles: input.roles ?? [] },
      })
      return id
    })
    const tenant = await tenants.find(context.tenantId)
    const delivery = await accounts.issueInvitation(
      user,
      context.tenantId,
      membershipId,
      tenant!.name,
      ttlDays
    )
    return { member: await this.get(context, membershipId), delivery }
  }

  /** Reenvia o convite de um membro ainda convidado (o anterior deixa de valer). */
  async resendInvitation(context: TenantContext, id: string) {
    const { member, ttlDays } = await runInTenant(context, async (scope) => {
      const found = await memberships.find(scope, id, true)
      if (!found) throw ApiError.notFound()
      if (found.status !== 'INVITED')
        throw ApiError.conflict(
          'NOT_INVITED',
          'Só se reenvia o convite de quem ainda não o aceitou.'
        )
      await audit(scope, {
        action: 'member.invitation_resent',
        entityType: 'membership',
        entityId: id,
      })
      return { member: found, ttlDays: (await tenantSettings(scope)).invitationTtlDays }
    })
    const tenant = await tenants.find(context.tenantId)
    const user = { id: member.userId, email: member.email } as Parameters<
      AccountService['issueInvitation']
    >[0]
    const delivery = await accounts.issueInvitation(
      user,
      context.tenantId,
      id,
      tenant!.name,
      ttlDays
    )
    return { member: await this.get(context, id), delivery }
  }

  /** Revoga um convite pendente: a membership fica REVOKED e a ligação do email deixa de funcionar. */
  async revokeInvitation(context: TenantContext, id: string) {
    const member = await runInTenant(context, async (scope) => {
      const found = await memberships.find(scope, id, true)
      if (!found) throw ApiError.notFound()
      if (found.status !== 'INVITED')
        throw ApiError.conflict('NOT_INVITED', 'Só se revoga um convite ainda não aceite.')
      await memberships.setStatus(scope, id, found.version, 'REVOKED')
      await audit(scope, {
        action: 'member.invitation_revoked',
        entityType: 'membership',
        entityId: id,
        changes: { status: { from: 'INVITED', to: 'REVOKED' } },
      })
      return found
    })
    await accounts.revokeInvitations(member.userId, context.tenantId)
    return this.get(context, id)
  }

  /** Público: aceita o convite (activa a membership na mesma transacção que consome o token). */
  acceptInvitation(input: { token: unknown; password?: unknown; fullName?: unknown }) {
    return accounts.consumeInvitation(
      input.token,
      input.password,
      input.fullName,
      async (trx, invitation) => {
        await memberships.activateInvited(
          trx,
          invitation.tenantId,
          invitation.membershipId,
          invitation.userId
        )
        await writeAudit(
          trx,
          {
            tenantId: invitation.tenantId,
            userId: invitation.userId,
            membershipId: invitation.membershipId,
            requestId: null,
          },
          {
            action: 'member.invitation_accepted',
            entityType: 'membership',
            entityId: invitation.membershipId,
            changes: { status: { from: 'INVITED', to: 'ACTIVE' } },
          }
        )
      }
    )
  }

  setStatus(
    context: TenantContext,
    id: string,
    expectedVersion: number,
    status: 'ACTIVE' | 'SUSPENDED'
  ) {
    return runInTenant(context, async (scope) => {
      if (id === context.membershipId) {
        throw ApiError.forbidden(
          'SELF_STATUS',
          'Não pode alterar o estado da sua própria participação.'
        )
      }
      const member = await memberships.find(scope, id, true)
      if (!member) throw ApiError.notFound()
      if (member.status === 'INVITED' || member.status === 'REVOKED') {
        throw ApiError.conflict('INVALID_STATE', 'Só membros activos ou suspensos mudam de estado.')
      }
      if (status === 'SUSPENDED') await assignments.assertNotLastAdmin(scope, id)
      await memberships.setStatus(scope, id, expectedVersion, status)
      await audit(scope, {
        action: status === 'SUSPENDED' ? 'member.suspended' : 'member.reactivated',
        entityType: 'membership',
        entityId: id,
        changes: { status: { from: member.status, to: status } },
      })
      return withRoles(
        (await memberships.find(scope, id))!,
        await assignments.assignments(scope, [id])
      )
    })
  }

  assignRole(
    context: TenantContext,
    id: string,
    input: { roleId: string; scopeType?: string; scopeId?: string | null }
  ) {
    return runInTenant(context, async (scope) => {
      const member = await memberships.find(scope, id, true)
      if (!member) throw ApiError.notFound()
      await assignments.assign(
        scope,
        id,
        input.roleId,
        input.scopeType ?? 'TENANT',
        input.scopeId ?? null
      )
      const after = await assignments.assignments(scope, [id])
      const added = after.find(
        (a) =>
          a.roleId === input.roleId &&
          a.scopeType === (input.scopeType ?? 'TENANT') &&
          a.scopeId === (input.scopeId ?? null)
      )
      await audit(scope, {
        action: 'member.role_assigned',
        entityType: 'membership',
        entityId: id,
        metadata: {
          assignmentId: added?.id ?? null,
          roleId: input.roleId,
          roleCode: added?.roleCode ?? null,
          scopeType: input.scopeType ?? 'TENANT',
          scopeId: input.scopeId ?? null,
        },
      })
      return withRoles(member, after)
    })
  }

  unassignRole(context: TenantContext, id: string, assignmentId: string) {
    return runInTenant(context, async (scope) => {
      const member = await memberships.find(scope, id, true)
      if (!member) throw ApiError.notFound()
      const removed = (await assignments.assignments(scope, [id])).find(
        (a) => a.id === assignmentId
      )
      await assignments.unassign(scope, id, assignmentId)
      await audit(scope, {
        action: 'member.role_unassigned',
        entityType: 'membership',
        entityId: id,
        metadata: removed
          ? {
              assignmentId,
              roleId: removed.roleId,
              roleCode: removed.roleCode,
              scopeType: removed.scopeType,
              scopeId: removed.scopeId,
            }
          : { assignmentId },
      })
      return withRoles(member, await assignments.assignments(scope, [id]))
    })
  }
}
