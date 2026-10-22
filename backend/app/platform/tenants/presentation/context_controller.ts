import type { HttpContext } from '@adonisjs/core/http'
import { envelope } from '#core/http/api_response'
import { tenantServices } from '#platform/tenants/presentation/composition'

export default class ContextController {
  /** Tenants a que o utilizador autenticado pode aceder (para o selector da interface). */
  async myTenants(ctx: HttpContext) {
    return envelope(ctx, await tenantServices().listMyTenants.execute(ctx.principal.user.id))
  }

  /**
   * Contexto do pedido actual. Os módulos, funcionalidades, permissões e configurações de apresentação
   * da spec (C05/C06) só passam a constar quando esses componentes existirem; não se devolvem vazios.
   */
  async show(ctx: HttpContext) {
    const { tenant, membership, tenantContext, principal } = ctx
    return envelope(ctx, {
      tenant: {
        id: tenant.id,
        code: tenant.code,
        name: tenant.name,
        status: tenant.status,
        defaultLocale: tenant.defaultLocale,
        timezone: tenant.timezone,
      },
      membership: { id: membership.id, status: membership.status, joinedAt: membership.joinedAt },
      user: {
        id: principal.user.id,
        email: principal.user.email,
        displayName: principal.user.displayName,
      },
      locale: tenantContext.locale,
      authorizationVersion: tenantContext.permissionsVersion,
      unitScope: tenantContext.unitScope,
    })
  }
}
