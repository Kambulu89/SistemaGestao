import type { HttpContext } from '@adonisjs/core/http'
import { ok } from '#shared/http/respond'

/** Contexto efectivo resolvido no servidor para o tenant pedido. */
export default class ContextController {
  async show(ctx: HttpContext) {
    const tenant = ctx.tenant!
    return ok(ctx, {
      tenant: {
        id: tenant.id,
        code: tenant.code,
        name: tenant.name,
        countryCode: tenant.countryCode,
        defaultCurrency: tenant.defaultCurrency,
        locale: tenant.locale,
        timezone: tenant.timezone,
      },
      membershipId: ctx.tenantContext!.membershipId,
    })
  }
}
