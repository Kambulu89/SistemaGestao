import { ApiError } from '#shared/http/api_error'
import { AccountService, type DeliveryStatus } from '#modules/identity/index'
import {
  MembershipRepository,
  runInTenant,
  TenantRepository,
  type Member,
  type MembershipStatus,
  type TenantContext,
} from '#modules/tenancy/index'
import { AssignmentService, type Assignment } from '#modules/rbac/index'

const memberships = new MembershipRepository()
const assignments = new AssignmentService()
const accounts = new AccountService()
const tenants = new TenantRepository()

export interface MemberView extends Member {
  roles: Pick<Assignment, 'id' | 'roleId' | 'roleCode' | 'scopeType'>[]
}

const withRoles = (member: Member, all: Assignment[]): MemberView => ({
  ...member,
  roles: all
    .filter((a) => a.membershipId === member.id)
    .map(({ id, roleId, roleCode, scopeType }) => ({ id, roleId, roleCode, scopeType })),
})

/** Membros da empresa: convites, aceitação, suspensão e perfis. As regras de perfis vivem no RBAC. */
export class MemberService {
  list(
    context: TenantContext,
    filter: { status?: MembershipStatus; q?: string; limit?: number; offset?: number }
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
    })
  }

  get(context: TenantContext, id: string): Promise<MemberView> {
    return runInTenant(context, async (scope) => {
      const member = await memberships.find(scope, id)
      if (!member) throw ApiError.notFound()
      return withRoles(member, await assignments.assignments(scope, [id]))
    })
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
      roles?: { roleId: string; scopeType?: string }[]
    }
  ): Promise<{ member: MemberView; delivery: DeliveryStatus }> {
    const user = await accounts.findOrCreateForInvitation(input.email, input.fullName)
    const membershipId = await runInTenant(context, async (scope) => {
      const id = await memberships.insertInvited(scope, user.id)
      for (const role of input.roles ?? [])
        await assignments.assign(scope, id, role.roleId, role.scopeType ?? 'TENANT')
      return id
    })
    const tenant = await tenants.find(context.tenantId)
    const delivery = await accounts.issueInvitation(
      user,
      context.tenantId,
      membershipId,
      tenant!.name
    )
    return { member: await this.get(context, membershipId), delivery }
  }

  /** Público: aceita o convite (activa a membership na mesma transacção que consome o token). */
  acceptInvitation(input: { token: unknown; password?: unknown; fullName?: unknown }) {
    return accounts.consumeInvitation(
      input.token,
      input.password,
      input.fullName,
      (trx, invitation) =>
        memberships.activateInvited(
          trx,
          invitation.tenantId,
          invitation.membershipId,
          invitation.userId
        )
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
      return withRoles(
        (await memberships.find(scope, id))!,
        await assignments.assignments(scope, [id])
      )
    })
  }

  assignRole(context: TenantContext, id: string, input: { roleId: string; scopeType?: string }) {
    return runInTenant(context, async (scope) => {
      const member = await memberships.find(scope, id, true)
      if (!member) throw ApiError.notFound()
      await assignments.assign(scope, id, input.roleId, input.scopeType ?? 'TENANT')
      return withRoles(member, await assignments.assignments(scope, [id]))
    })
  }

  unassignRole(context: TenantContext, id: string, assignmentId: string) {
    return runInTenant(context, async (scope) => {
      const member = await memberships.find(scope, id, true)
      if (!member) throw ApiError.notFound()
      await assignments.unassign(scope, id, assignmentId)
      return withRoles(member, await assignments.assignments(scope, [id]))
    })
  }
}
