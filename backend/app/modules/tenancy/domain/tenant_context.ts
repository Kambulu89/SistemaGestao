/**
 * Contexto de tenant de um pedido ou job, resolvido **no servidor** (sessão + membership activa). Um `tenantId` vindo do
 * cliente é só um selector a validar, nunca autorização.
 */
export interface TenantContext {
  readonly tenantId: string
  readonly userId: string
  readonly membershipId: string
  readonly requestId: string
}

export class MissingTenantContextError extends Error {
  constructor() {
    super('Operação de tenant sem contexto de tenant: negada.')
  }
}
