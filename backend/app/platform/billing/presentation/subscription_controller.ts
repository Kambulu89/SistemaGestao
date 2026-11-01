import type { HttpContext } from '@adonisjs/core/http'
import { envelope } from '#core/http/api_response'
import { billingServices } from '#platform/billing/presentation/composition'

export default class SubscriptionController {
  /**
   * Assinatura do tenant do contexto: capacidades, consumo, limites e bloqueios da versão **contratada**.
   * O tenant vem sempre do contexto validado, nunca do pedido.
   */
  async show(ctx: HttpContext) {
    const { plan, subscription, entitled, usage, history } =
      await billingServices().tenantSubscription.execute(ctx.tenantContext.tenantId)
    return envelope(ctx, {
      plan: {
        code: plan.planCode,
        revision: plan.revision,
        name: plan.name,
        price: plan.price,
        currency: plan.currency,
        billingInterval: plan.billingInterval,
        limits: plan.limits,
        entitlements: plan.entitlements,
      },
      subscription: {
        status: subscription.status,
        entitled,
        startsAt: subscription.startsAt,
        periodEnd: subscription.periodEnd,
        trialEnd: subscription.trialEnd,
        graceEnd: subscription.graceEnd,
        adequacyUntil: subscription.adequacyUntil,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      },
      usage,
      history: history.map((change) => ({
        kind: change.kind,
        fromStatus: change.fromStatus,
        toStatus: change.toStatus,
        adequacyUntil: change.adequacyUntil,
        occurredAt: change.occurredAt,
      })),
    })
  }
}
