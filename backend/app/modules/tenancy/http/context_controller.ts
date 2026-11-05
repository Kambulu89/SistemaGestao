import type { HttpContext } from '@adonisjs/core/http'
import { ok } from '#shared/http/respond'
import { entitlementsFor } from '#modules/subscription/index'

/**
 * Contexto efectivo resolvido no servidor para o tenant pedido. Inclui o estado da subscrição e as funcionalidades
 * activas, para a interface não oferecer o que a empresa não contratou (a API continua a verificar cada pedido).
 */
export default class ContextController {
  async show(ctx: HttpContext) {
    const tenant = ctx.tenant!
    const { status, features } = await entitlementsFor(tenant.id)
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
      subscriptionStatus: status,
      features: [...features.values()]
        .filter((f) => f.enabled)
        .map((f) => ({ code: f.code, limit: f.limit })),
    })
  }
}
