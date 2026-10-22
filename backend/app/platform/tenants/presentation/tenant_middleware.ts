import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { securityEvents } from '#core/audit/index'
import { ApiError } from '#core/http/api_error'
import { tenantContextStore, type TenantContext } from '#core/tenancy/index'
import type { Membership } from '#core/membership/index'
import type { Tenant } from '#platform/tenants/domain/tenant'
import { tenantServices } from '#platform/tenants/presentation/composition'

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /** Contexto imutável do tenant (só nas rotas com o middleware `tenant`, depois de `auth`). */
    tenantContext: TenantContext
    tenant: Tenant
    membership: Membership
  }
}

/**
 * Resolve e valida o tenant do pedido (a seguir à autenticação) e corre o resto do pedido com o
 * `TenantContext` no `TenantContextStore`. Sem selector válido e membership activa, o pedido termina
 * aqui: nunca há "tenant por omissão".
 */
export default class TenantMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const { request, principal } = ctx
    let resolved
    try {
      resolved = await tenantServices().resolveTenantContext.execute({
        user: principal.user,
        correlationId: ctx.correlationId,
        selector: {
          tenantId: request.header('x-tenant-id'),
          tenantCode: request.header('x-tenant-code'),
          host: request.header('host'),
        },
      })
    } catch (error) {
      // Sem tenant_id: o evento é global (o selector pode ser alheio e não prova nada).
      if (error instanceof ApiError && error.status === 403) {
        await securityEvents.record({
          type: 'TENANT_ACCESS_DENIED',
          severity: 'WARN',
          userId: principal.user.id,
          metadata: { path: request.url() },
        })
      }
      throw error
    }

    ctx.tenantContext = resolved.context
    ctx.tenant = resolved.tenant
    ctx.membership = resolved.membership
    ctx.logger = ctx.logger.child({
      tenantId: resolved.context.tenantId,
      membershipId: resolved.context.membershipId,
    })
    return tenantContextStore.run(resolved.context, () => next())
  }
}
