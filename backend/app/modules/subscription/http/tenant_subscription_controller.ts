import type { HttpContext } from '@adonisjs/core/http'
import { ok } from '#shared/http/respond'
import { entitlementsFor } from '#modules/subscription/application/entitlements'

/** A subscrição da própria empresa (só leitura): plano, estado efectivo e funcionalidades. */
export default class TenantSubscriptionController {
  async show(ctx: HttpContext) {
    const { subscription, status, plan, features } = await entitlementsFor(
      ctx.tenantContext!.tenantId
    )
    return ok(ctx, {
      status,
      plan: plan ? { code: plan.code, name: plan.name } : null,
      trialEndsAt: subscription?.trialEndsAt ?? null,
      endsAt: subscription?.endsAt ?? null,
      entitlements: [...features.values()],
    })
  }
}
