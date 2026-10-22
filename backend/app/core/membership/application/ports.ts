import type { TenantScope } from '#core/tenancy/index'
import type { Membership, MembershipStatus } from '#core/membership/domain/membership'

/**
 * Leitura das memberships **do próprio utilizador**, antes de haver contexto de tenant (resolução do
 * tenant do pedido). A base só devolve linhas desse utilizador.
 */
export interface MembershipDirectory {
  listForUser(userId: string): Promise<Membership[]>
  findForUser(userId: string, tenantId: string): Promise<Membership | null>
}

/** Escritas, sempre dentro do âmbito (contexto de tenant) de uma transacção. */
export interface MembershipStore {
  /** `null` se o utilizador já tiver membership neste tenant. */
  insert(
    scope: TenantScope,
    input: { userId: string; status: MembershipStatus }
  ): Promise<Membership | null>
  findByUser(scope: TenantScope, userId: string): Promise<Membership | null>
  changeStatus(
    scope: TenantScope,
    membership: Membership,
    status: MembershipStatus
  ): Promise<Membership>
}
