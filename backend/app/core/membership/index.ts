/** API pública do módulo de membros (C05). Outros módulos importam **apenas** daqui. */
export {
  MEMBERSHIP_STATUSES,
  canTransitionMembership,
  grantsAccess,
  type Membership,
  type MembershipStatus,
} from '#core/membership/domain/membership'
export type { MembershipDirectory, MembershipStore } from '#core/membership/application/ports'
export { AddMember, ChangeMembershipStatus } from '#core/membership/application/use_cases'
export {
  LucidMembershipDirectory,
  LucidMembershipStore,
} from '#core/membership/infrastructure/lucid_membership'
