import type { HttpContext } from '@adonisjs/core/http'
import { envelope } from '#core/http/api_response'
import { iamServices } from '#core/permissions/index'
import { moduleServices } from '#platform/modules/index'
import { tenantServices } from '#platform/tenants/presentation/composition'

export default class ContextController {
  /** Tenants a que o utilizador autenticado pode aceder (para o selector da interface). */
  async myTenants(ctx: HttpContext) {
    return envelope(ctx, await tenantServices().listMyTenants.execute(ctx.principal.user.id))
  }

  /**
   * Contexto do pedido actual. Módulos e funcionalidades (C03) activos; configurações (C09) só constam quando
   * existirem. As permissões são só para apresentação.
   */
  async show(ctx: HttpContext) {
    const { tenant, membership, tenantContext, principal } = ctx
    const permissions = await iamServices().effectivePermissions.execute(tenantContext)
    const modules = await moduleServices().listModules.execute(tenantContext)
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
      permissions,
      // Só conveniência para a interface; cada comando volta a ser verificado no servidor.
      modules: modules.filter((m) => m.status === 'ENABLED').map((m) => m.code),
      features: modules
        .flatMap((m) => m.features)
        .filter((f) => f.enabled)
        .map((f) => f.code),
    })
  }
}
