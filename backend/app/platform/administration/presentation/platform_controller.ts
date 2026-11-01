import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { securityEvents } from '#core/audit/index'
import { billingServices, type PlanVersion, type Subscription } from '#platform/billing/index'
import { administrationServices } from '#platform/administration/presentation/composition'
import {
  assignValidator,
  changePlanValidator,
  createPlanValidator,
  provisionValidator,
  reasonValidator,
  statusValidator,
} from '#platform/administration/presentation/validators'

function tenantId(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound('Tenant não encontrado.')
  return id
}

const planView = (p: PlanVersion) => ({
  planCode: p.planCode,
  revision: p.revision,
  name: p.name,
  currency: p.currency,
  price: p.price,
  billingInterval: p.billingInterval,
  limits: p.limits,
  entitlements: p.entitlements,
  status: p.status,
  publishedAt: p.publishedAt,
})

const subscriptionView = (s: Subscription) => ({
  status: s.status,
  startsAt: s.startsAt,
  periodEnd: s.periodEnd,
  trialEnd: s.trialEnd,
  graceEnd: s.graceEnd,
  adequacyUntil: s.adequacyUntil,
  cancelAtPeriodEnd: s.cancelAtPeriodEnd,
})

/** Regista a acção de plataforma (quem, o quê, em que tenant) nos eventos de segurança. */
function audited(
  ctx: HttpContext,
  action: string,
  tenant: string | null,
  metadata: Record<string, unknown> = {}
) {
  return securityEvents.record({
    type: 'PLATFORM_ACTION',
    severity: 'INFO',
    userId: ctx.principal.user.id,
    tenantId: tenant,
    metadata: { action, ...metadata },
  })
}

/** Transporte apenas. As rotas exigem `platform.*` (middleware `platform`) e não têm selector de tenant. */
export default class PlatformController {
  /** As permissões de plataforma da própria conta (vazio = não é administrador de plataforma). */
  async me(ctx: HttpContext) {
    return envelope(ctx, {
      permissions: await administrationServices().authorize.permissionsOf(ctx.principal.user.id),
    })
  }

  // --- tenants ---------------------------------------------------------------------------------

  async listTenants(ctx: HttpContext) {
    return envelope(ctx, await administrationServices().listTenants.execute())
  }

  /** Provisiona (ou retoma o provisionamento de) um tenant; `201` se criou, `200` se já existia. */
  async provision(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(provisionValidator)
    const result = await administrationServices().provisionTenant.execute(input)
    await audited(ctx, 'tenant.provision', result.tenant.id, {
      planCode: input.planCode,
      created: result.created,
    })
    ctx.response.status(result.created ? 201 : 200)
    if (result.created)
      ctx.response.header('location', `/api/v1/platform/tenants/${result.tenant.id}`)
    return envelope(ctx, result)
  }

  async showTenant(ctx: HttpContext) {
    return envelope(ctx, await administrationServices().getTenant.execute(tenantId(ctx)))
  }

  async suspend(ctx: HttpContext) {
    const { reason } = await ctx.request.validateUsing(reasonValidator)
    const id = tenantId(ctx)
    const tenant = await administrationServices().changeLifecycle.execute(id, 'SUSPENDED')
    await audited(ctx, 'tenant.suspend', id, { reason })
    return envelope(ctx, tenant)
  }

  async resume(ctx: HttpContext) {
    const { reason } = await ctx.request.validateUsing(reasonValidator)
    const id = tenantId(ctx)
    const tenant = await administrationServices().changeLifecycle.execute(id, 'ACTIVE')
    await audited(ctx, 'tenant.resume', id, { reason })
    return envelope(ctx, tenant)
  }

  // --- planos ----------------------------------------------------------------------------------

  async listPlans(ctx: HttpContext) {
    const plans = await billingServices().listPlans.execute()
    return envelope(ctx, plans.map(planView))
  }

  async createPlan(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createPlanValidator)
    const plan = await billingServices().createPlan.execute({
      ...input,
      limits: input.limits as unknown,
    })
    await audited(ctx, 'plan.create', null, { planCode: plan.planCode, revision: plan.revision })
    ctx.response.status(201)
    return envelope(ctx, planView(plan))
  }

  async publishPlan(ctx: HttpContext) {
    const plan = await billingServices().publishPlan.execute(
      ctx.params.code,
      Number(ctx.params.revision)
    )
    await audited(ctx, 'plan.publish', null, { planCode: plan.planCode, revision: plan.revision })
    return envelope(ctx, planView(plan))
  }

  async retirePlan(ctx: HttpContext) {
    const plan = await billingServices().retirePlan.execute(
      ctx.params.code,
      Number(ctx.params.revision)
    )
    await audited(ctx, 'plan.retire', null, { planCode: plan.planCode, revision: plan.revision })
    return envelope(ctx, planView(plan))
  }

  // --- assinaturas -----------------------------------------------------------------------------

  async showSubscription(ctx: HttpContext) {
    const view = await billingServices().tenantSubscription.execute(tenantId(ctx))
    return envelope(ctx, {
      plan: planView(view.plan),
      subscription: subscriptionView(view.subscription),
      entitled: view.entitled,
      usage: view.usage,
      history: view.history,
    })
  }

  async assign(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(assignValidator)
    const id = tenantId(ctx)
    const subscription = await billingServices().assignSubscription.execute({
      tenantId: id,
      planCode: input.planCode,
      revision: input.revision,
      trialDays: input.trialDays,
    })
    await audited(ctx, 'subscription.assign', id, { planCode: input.planCode })
    return envelope(ctx, subscriptionView(subscription))
  }

  async changePlan(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(changePlanValidator)
    const id = tenantId(ctx)
    const subscription = await billingServices().changePlan.execute({
      tenantId: id,
      planCode: input.planCode,
      revision: input.revision,
      adequacyDays: input.adequacyDays,
    })
    await audited(ctx, 'subscription.change_plan', id, {
      planCode: input.planCode,
      adequacyDays: input.adequacyDays ?? null,
    })
    return envelope(ctx, subscriptionView(subscription))
  }

  async setStatus(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(statusValidator)
    const id = tenantId(ctx)
    const subscription = await billingServices().setSubscriptionStatus.execute({
      tenantId: id,
      status: input.status,
      graceDays: input.graceDays,
    })
    await audited(ctx, 'subscription.set_status', id, { status: input.status })
    return envelope(ctx, subscriptionView(subscription))
  }
}
