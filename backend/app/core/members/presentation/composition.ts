import { authServices } from '#core/auth/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { LucidMembershipStore } from '#core/membership/index'
import { LucidOrganizationStore } from '#core/organization/index'
import { iamServices, LucidIamStore } from '#core/permissions/index'
import {
  AcceptInvitation,
  InvitationUseCases,
  MemberUseCases,
  PreferenceUseCases,
} from '#core/members/application/use_cases'
import type { MemberQuota, TenantGate, UserDirectory } from '#core/members/application/ports'
import {
  LucidInvitationStore,
  LucidPreferenceStore,
} from '#core/members/infrastructure/lucid_members'

function build() {
  const uow = new LucidTenantDatabase()
  const memberships = new LucidMembershipStore()
  const iam = new LucidIamStore()
  const organizations = new LucidOrganizationStore()
  const invitations = new LucidInvitationStore()
  const clock = { now: () => new Date() }
  const auth = authServices()

  const users: UserDirectory = {
    findByEmail: async (email) => {
      const user = await auth.users.findByEmail(email)
      return user ? { id: user.id, email: user.email, displayName: user.displayName } : null
    },
    findByIds: async (ids) => {
      const found = await auth.users.findByIds(ids)
      return found.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName }))
    },
  }
  const mailer = {
    send: (message: { to: string; token: string; expiresAt: Date }) =>
      auth.mailer.send({ ...message, purpose: 'INVITATION' }),
  }

  return {
    invitations: new InvitationUseCases(
      uow,
      invitations,
      memberships,
      iam,
      organizations,
      users,
      mailer,
      clock
    ),
    members: new MemberUseCases(uow, memberships, iam, organizations, users, iamServices().guard),
    preferences: new PreferenceUseCases(uow, new LucidPreferenceStore()),
    /** A aceitação precisa do estado do tenant e da quota (plano de controlo): vêm da plataforma. */
    acceptInvitation: (gate: TenantGate, quota: MemberQuota) =>
      new AcceptInvitation(uow, invitations, memberships, iam, organizations, gate, quota, clock),
  }
}

let instance: ReturnType<typeof build> | undefined

export const memberServices = () => (instance ??= build())
