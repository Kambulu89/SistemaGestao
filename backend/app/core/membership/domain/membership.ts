export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'LEFT'

export interface Membership {
  id: string
  tenantId: string
  userId: string
  status: MembershipStatus
  joinedAt: Date | null
  defaultOrganizationId: string | null
  /** Incrementa sempre que os acessos mudam; faz parte do `TenantContext.permissionsVersion`. */
  authorizationVersion: number
  version: number
}

/** `LEFT` é terminal: voltar a entrar exige um convite novo (fatia 1.6). */
const TRANSITIONS: Record<MembershipStatus, readonly MembershipStatus[]> = {
  INVITED: ['ACTIVE', 'LEFT'],
  ACTIVE: ['SUSPENDED', 'LEFT'],
  SUSPENDED: ['ACTIVE', 'LEFT'],
  LEFT: [],
}

export const MEMBERSHIP_STATUSES = Object.keys(TRANSITIONS) as MembershipStatus[]

export const canTransitionMembership = (from: MembershipStatus, to: MembershipStatus): boolean =>
  TRANSITIONS[from].includes(to)

/** Só uma membership activa dá acesso ao tenant. */
export const grantsAccess = (membership: Pick<Membership, 'status'>): boolean =>
  membership.status === 'ACTIVE'
