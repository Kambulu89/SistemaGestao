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
  findById(scope: TenantScope, membershipId: string): Promise<Membership | null>
  /**
   * Incrementa a `authorizationVersion` (invalida decisões e caches). Chamado por quem altera acessos
   * (papéis, atribuições, políticas): é a API pública do módulo, que é dono da tabela.
   */
  bumpAuthorization(scope: TenantScope, membershipIds: readonly string[]): Promise<void>
  bumpAllAuthorization(scope: TenantScope): Promise<void>
  changeStatus(
    scope: TenantScope,
    membership: Membership,
    status: MembershipStatus
  ): Promise<Membership>
}
