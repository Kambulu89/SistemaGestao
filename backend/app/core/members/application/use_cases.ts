import { ApiError, type ApiErrorDetail } from '#core/http/api_error'
import {
  serviceTenantContext,
  type TenantContext,
  type TenantUnitOfWork,
} from '#core/tenancy/index'
import { isValidEmail, normalizeEmail } from '#core/auth/index'
import {
  canTransitionMembership,
  type Membership,
  type MembershipStatus,
  type MembershipStore,
} from '#core/membership/index'
import type { AdminGuard, IamStore } from '#core/permissions/index'
import type { OrganizationStore } from '#core/organization/index'
import {
  INVITATION_DEFAULT_DAYS,
  INVITATION_MAX_DAYS,
  INVITATION_MAX_ITEMS,
  effectiveStatus,
  newInvitationToken,
  parseInvitationToken,
  type Invitation,
  type InvitationStatus,
} from '#core/members/domain/invitation'
import { isKnownPreference, isValidPreferenceValue } from '#core/members/domain/preferences'
import type {
  InvitationMailer,
  InvitationStore,
  MemberQuota,
  PreferenceStore,
  TenantGate,
  UserDirectory,
} from '#core/members/application/ports'

const DAY_MS = 24 * 60 * 60 * 1000

const validation = (details: ApiErrorDetail[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

/** Resposta única para qualquer convite que não possa ser aceite: não revela porquê. */
const invalidInvitation = () =>
  new ApiError(400, 'INVALID_OR_EXPIRED_TOKEN', 'O convite é inválido ou expirou.')

interface Clock {
  now(): Date
}

export interface InvitationView {
  id: string
  email: string
  status: InvitationStatus
  expiresAt: Date
  acceptedAt: Date | null
  roleIds: string[]
  unitIds: string[]
  version: number
}

const toView = (invitation: Invitation, now: Date): InvitationView => ({
  id: invitation.id,
  email: invitation.email,
  status: effectiveStatus(invitation, now),
  expiresAt: invitation.expiresAt,
  acceptedAt: invitation.acceptedAt,
  roleIds: invitation.roleIds,
  unitIds: invitation.unitIds,
  version: invitation.version,
})

// --- convites ------------------------------------------------------------------------------------

export class InvitationUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly invitations: InvitationStore,
    private readonly memberships: MembershipStore,
    private readonly iam: IamStore,
    private readonly organizations: OrganizationStore,
    private readonly users: UserDirectory,
    private readonly mailer: InvitationMailer,
    private readonly clock: Clock
  ) {}

  list(context: TenantContext): Promise<InvitationView[]> {
    const now = this.clock.now()
    return this.uow.run(async (scope) => {
      const all = await this.invitations.list(scope)
      return all.map((i) => toView(i, now))
    }, context)
  }

  /** O convite vai por email (nunca na resposta): quem convida não vê o token. */
  create(
    context: TenantContext,
    input: { email: string; roleIds: string[]; unitIds: string[]; expiresInDays?: number }
  ): Promise<InvitationView> {
    const email = normalizeEmail(input.email)
    const days = input.expiresInDays ?? INVITATION_DEFAULT_DAYS
    const details: ApiErrorDetail[] = []
    if (!isValidEmail(email)) {
      details.push({ path: 'email', code: 'INVALID_EMAIL', message: 'O email não é válido.' })
    }
    if (!Number.isInteger(days) || days < 1 || days > INVITATION_MAX_DAYS) {
      details.push({
        path: 'expiresInDays',
        code: 'INVALID_EXPIRY',
        message: `Entre 1 e ${INVITATION_MAX_DAYS} dias.`,
      })
    }
    const roleIds = [...new Set(input.roleIds)]
    const unitIds = [...new Set(input.unitIds)]
    if (roleIds.length > INVITATION_MAX_ITEMS || unitIds.length > INVITATION_MAX_ITEMS) {
      details.push({
        path: 'roleIds',
        code: 'TOO_MANY',
        message: `No máximo ${INVITATION_MAX_ITEMS}.`,
      })
    }
    if (details.length > 0) throw validation(details)

    const now = this.clock.now()
    return this.uow.run(async (scope) => {
      const problems: ApiErrorDetail[] = []
      for (const [i, id] of roleIds.entries()) {
        if (!(await this.iam.findRole(scope, id))) {
          problems.push({
            path: `roleIds[${i}]`,
            code: 'NOT_FOUND',
            message: 'Papel inexistente neste tenant.',
          })
        }
      }
      for (const [i, id] of unitIds.entries()) {
        if (!(await this.organizations.findUnit(scope, id))) {
          problems.push({
            path: `unitIds[${i}]`,
            code: 'NOT_FOUND',
            message: 'Unidade inexistente neste tenant.',
          })
        }
      }
      if (problems.length > 0) throw validation(problems)

      // Quem já pertence ao tenant (qualquer estado menos LEFT) não precisa de convite.
      const user = await this.users.findByEmail(email)
      const existing = user ? await this.memberships.findByUser(scope, user.id) : null
      if (existing && existing.status !== 'LEFT') {
        throw ApiError.conflict('ALREADY_MEMBER', 'Este utilizador já pertence ao tenant.')
      }

      await this.invitations.expirePending(scope, email, now)
      const { token, tokenHash } = newInvitationToken(context.tenantId)
      const expiresAt = new Date(now.getTime() + days * DAY_MS)
      const created = await this.invitations.insert(scope, {
        email,
        tokenHash,
        invitedByMembershipId: context.membershipId,
        expiresAt,
        roleIds,
        unitIds,
      })
      if (!created) {
        throw ApiError.conflict(
          'INVITATION_PENDING',
          'Já existe um convite pendente para este email. Revogue-o para enviar outro.'
        )
      }
      // Dentro da transacção: se o envio falhar, o convite não fica registado sem ter sido enviado.
      await this.mailer.send({ to: email, token, expiresAt })
      return toView(created, now)
    }, context)
  }

  revoke(context: TenantContext, id: string): Promise<void> {
    const now = this.clock.now()
    return this.uow.run(async (scope) => {
      const invitation = await this.invitations.findById(scope, id)
      if (!invitation) throw ApiError.notFound('Convite não encontrado.')
      if (effectiveStatus(invitation, now) !== 'PENDING') {
        throw ApiError.conflict(
          'INVALID_STATE_TRANSITION',
          'Só um convite pendente pode ser revogado.'
        )
      }
      await this.invitations.setStatus(scope, invitation, 'REVOKED', now)
    }, context)
  }
}

/**
 * Aceitação do convite por um utilizador **autenticado**: o email da conta tem de ser o do convite
 * (controlo do email) e o token válido. Tudo numa transacção, com lock por tenant: o token é de uso
 * único e a quota de membros respeita-se sob concorrência.
 */
export class AcceptInvitation {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly invitations: InvitationStore,
    private readonly memberships: MembershipStore,
    private readonly iam: IamStore,
    private readonly organizations: OrganizationStore,
    private readonly gate: TenantGate,
    private readonly quota: MemberQuota,
    private readonly clock: Clock
  ) {}

  async execute(
    user: { id: string; email: string },
    token: string
  ): Promise<{ tenantId: string; membershipId: string }> {
    const parsed = parseInvitationToken(token)
    if (!parsed) throw invalidInvitation()
    const { tenantId, tokenHash } = parsed
    if (!(await this.gate.isOperational(tenantId))) throw invalidInvitation()
    const limit = await this.quota.limit(tenantId)
    const now = this.clock.now()
    const context = serviceTenantContext(tenantId, `invite-${Date.now()}`)

    return this.uow.run(async (scope) => {
      await this.memberships.lockMembers(scope)
      const invitation = await this.invitations.findByHash(scope, tokenHash)
      if (
        !invitation ||
        effectiveStatus(invitation, now) !== 'PENDING' ||
        invitation.email !== normalizeEmail(user.email)
      ) {
        throw invalidInvitation()
      }

      const existing = await this.memberships.findByUser(scope, user.id)
      if (existing?.status === 'ACTIVE') {
        throw ApiError.conflict('ALREADY_MEMBER', 'Já pertence a este tenant.')
      }
      if (existing?.status === 'SUSPENDED') throw invalidInvitation() // não se auto-reactiva

      const needsNewSlot = !existing || existing.status === 'LEFT'
      if (needsNewSlot && limit !== null) {
        if ((await this.memberships.countOccupied(scope)) + 1 > limit) {
          throw ApiError.conflict(
            'MEMBER_QUOTA_EXCEEDED',
            'O tenant atingiu o limite de membros do seu plano.'
          )
        }
      }

      let membership: Membership
      if (!existing) {
        const created = await this.memberships.insert(scope, { userId: user.id, status: 'ACTIVE' })
        if (!created) throw invalidInvitation()
        membership = created
      } else if (existing.status === 'LEFT') {
        membership = await this.memberships.reinstate(scope, existing)
      } else {
        membership = await this.memberships.changeStatus(scope, existing, 'ACTIVE')
      }

      // Papéis e unidades indicados no convite; o que entretanto deixou de existir é ignorado.
      for (const roleId of invitation.roleIds) {
        if (!(await this.iam.findRole(scope, roleId))) continue
        await this.iam.insertAssignment(scope, {
          membershipId: membership.id,
          roleId,
          organizationUnitId: null,
          validFrom: null,
          validUntil: null,
        })
      }
      for (const unitId of invitation.unitIds) {
        const unit = await this.organizations.findUnit(scope, unitId)
        if (!unit) continue
        await this.organizations.insertScope(scope, {
          membershipId: membership.id,
          organizationId: unit.organizationId,
          organizationUnitId: unit.id,
          includeDescendants: false,
        })
      }
      await this.memberships.bumpAuthorization(scope, [membership.id])
      await this.invitations.setStatus(scope, invitation, 'ACCEPTED', now)
      return { tenantId, membershipId: membership.id }
    }, context)
  }
}

// --- membros -------------------------------------------------------------------------------------

export interface MemberView {
  id: string
  userId: string
  email: string | null
  displayName: string | null
  status: MembershipStatus
  joinedAt: Date | null
  defaultOrganizationId: string | null
  authorizationVersion: number
  version: number
  roles: { assignmentId: string; roleId: string; roleCode: string }[]
}

export class MemberUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly memberships: MembershipStore,
    private readonly iam: IamStore,
    private readonly organizations: OrganizationStore,
    private readonly users: UserDirectory,
    private readonly guard: AdminGuard
  ) {}

  list(context: TenantContext): Promise<MemberView[]> {
    return this.uow.run(async (scope) => {
      const members = await this.memberships.list(scope)
      return this.present(scope, members)
    }, context)
  }

  get(context: TenantContext, id: string): Promise<MemberView> {
    return this.uow.run(async (scope) => {
      const member = await this.memberships.findById(scope, id)
      if (!member) throw ApiError.notFound('Membro não encontrado.')
      const [view] = await this.present(scope, [member])
      return view
    }, context)
  }

  /**
   * Suspende, reactiva ou termina uma membership (só neste tenant). Retirar o último administrador
   * activo é recusado (409 `LAST_ADMIN`). Incrementa a `authorizationVersion` (revogação imediata).
   */
  changeStatus(
    context: TenantContext,
    id: string,
    input: { status: MembershipStatus; expectedVersion: number }
  ): Promise<MemberView> {
    return this.uow.run(async (scope) => {
      const member = await this.memberships.findById(scope, id)
      if (!member) throw ApiError.notFound('Membro não encontrado.')
      if (member.version !== input.expectedVersion) throw ApiError.versionConflict(member.version)
      if (!canTransitionMembership(member.status, input.status)) {
        throw ApiError.conflict(
          'INVALID_STATE_TRANSITION',
          `Não é possível passar de ${member.status} para ${input.status}.`
        )
      }
      const changed = await this.guard.run(scope, () =>
        this.memberships.changeStatus(scope, member, input.status)
      )
      const [view] = await this.present(scope, [changed])
      return view
    }, context)
  }

  /** Organização por omissão do próprio membro (tem de existir neste tenant). */
  setOwnDefaultOrganization(
    context: TenantContext,
    organizationId: string | null
  ): Promise<MemberView> {
    return this.uow.run(async (scope) => {
      const member = await this.memberships.findById(scope, context.membershipId as string)
      if (!member) throw ApiError.notFound('Membro não encontrado.')
      if (organizationId && !(await this.organizations.findOrganization(scope, organizationId))) {
        throw validation([
          {
            path: 'organizationId',
            code: 'NOT_FOUND',
            message: 'Organização inexistente neste tenant.',
          },
        ])
      }
      const updated = await this.memberships.setDefaultOrganization(scope, member, organizationId)
      const [view] = await this.present(scope, [updated])
      return view
    }, context)
  }

  private async present(
    scope: Parameters<MembershipStore['list']>[0],
    members: Membership[]
  ): Promise<MemberView[]> {
    const [users, assignments, roles] = await Promise.all([
      this.users.findByIds(members.map((m) => m.userId)),
      this.iam.listAssignments(scope),
      this.iam.listRoles(scope),
    ])
    const userById = new Map(users.map((u) => [u.id, u]))
    const roleById = new Map(roles.map((r) => [r.id, r]))
    return members.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: userById.get(m.userId)?.email ?? null,
      displayName: userById.get(m.userId)?.displayName ?? null,
      status: m.status,
      joinedAt: m.joinedAt,
      defaultOrganizationId: m.defaultOrganizationId,
      authorizationVersion: m.authorizationVersion,
      version: m.version,
      roles: assignments
        .filter((a) => a.membershipId === m.id && roleById.has(a.roleId))
        .map((a) => ({
          assignmentId: a.id,
          roleId: a.roleId,
          roleCode: roleById.get(a.roleId)?.code as string,
        })),
    }))
  }
}

// --- preferências ----------------------------------------------------------------------------------

export class PreferenceUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: PreferenceStore
  ) {}

  list(context: TenantContext): Promise<Record<string, unknown>> {
    return this.uow.run((scope) => this.store.list(scope, context.membershipId as string), context)
  }

  /** Só chaves conhecidas, com valores validados; impostos, moeda e limites de segurança não são preferências. */
  set(context: TenantContext, key: string, value: unknown): Promise<void> {
    if (!isKnownPreference(key)) {
      throw validation([
        { path: 'key', code: 'UNKNOWN_PREFERENCE', message: 'Preferência desconhecida.' },
      ])
    }
    if (!isValidPreferenceValue(key, value)) {
      throw validation([
        { path: 'value', code: 'INVALID_VALUE', message: 'Valor inválido para esta preferência.' },
      ])
    }
    return this.uow.run(
      (scope) => this.store.upsert(scope, context.membershipId as string, key, value),
      context
    )
  }

  remove(context: TenantContext, key: string): Promise<void> {
    return this.uow.run(async (scope) => {
      if (!(await this.store.remove(scope, context.membershipId as string, key))) {
        throw ApiError.notFound('Preferência não encontrada.')
      }
    }, context)
  }
}
