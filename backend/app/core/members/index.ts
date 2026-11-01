/** API pública do módulo de membros e convites (C05). Outros módulos importam **apenas** daqui. */
export {
  effectiveStatus,
  parseInvitationToken,
  type Invitation,
  type InvitationStatus,
} from '#core/members/domain/invitation'
export { PREFERENCE_DEFINITIONS } from '#core/members/domain/preferences'
export type { MemberQuota, TenantGate } from '#core/members/application/ports'
export { memberServices } from '#core/members/presentation/composition'
