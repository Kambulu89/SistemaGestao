import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { FEATURES, PlatformSubscriptionService, entitlementsFor } from '#modules/subscription/index'
import { TenantRepository, normalizeTenant } from '#modules/tenancy/index'
import { createTenantWithAdmin } from '#modules/members/index'

const featureInput = vine.object({
  featureCode: vine.string().trim().maxLength(80),
  enabled: vine.boolean().optional(),
  limitValue: vine.number().withoutDecimals().min(0).nullable().optional(),
})
const createPlanValidator = vine.create({
  code: vine.string().trim().maxLength(40),
  name: vine.string().trim().maxLength(120),
  description: vine.string().trim().maxLength(500).nullable().optional(),
  trialDays: vine.number().withoutDecimals().optional(),
  features: vine.array(featureInput).maxLength(100).optional(),
})
const updatePlanValidator = vine.create({
  expectedVersion: vine.number().withoutDecimals().min(1),
  name: vine.string().trim().maxLength(120).optional(),
  description: vine.string().trim().maxLength(500).nullable().optional(),
  trialDays: vine.number().withoutDecimals().optional(),
  features: vine.array(featureInput).maxLength(100).optional(),
})
const startValidator = vine.create({
  planId: vine.string().uuid(),
  trial: vine.boolean().optional(),
  reason: vine.string().trim().maxLength(500).nullable().optional(),
})
const transitionValidator = vine.create({
  action: vine.enum(['ACTIVATE', 'SUSPEND', 'REACTIVATE', 'CANCEL', 'CHANGE_PLAN']),
  expectedVersion: vine.number().withoutDecimals().min(1),
  reason: vine.string().trim().maxLength(500).nullable().optional(),
  planId: vine.string().uuid().optional(),
})
const overrideValidator = vine.create({
  enabled: vine.boolean(),
  limitValue: vine.number().withoutDecimals().min(0).nullable().optional(),
  reason: vine.string().trim().maxLength(500),
  expiresAt: vine.string().trim().maxLength(40).nullable().optional(),
})
const createTenantValidator = vine.create({
  code: vine.string().trim().maxLength(30),
  name: vine.string().trim().maxLength(160),
  countryCode: vine.string().trim().maxLength(2),
  defaultCurrency: vine.string().trim().maxLength(3),
  adminEmail: vine.string().trim().maxLength(254),
})
const updateTenantValidator = vine.create({
  expectedVersion: vine.number().withoutDecimals().min(1),
  name: vine.string().trim().maxLength(160).optional(),
  countryCode: vine.string().trim().maxLength(2).optional(),
  defaultCurrency: vine.string().trim().maxLength(3).optional(),
  locale: vine.string().trim().maxLength(10).optional(),
  timezone: vine.string().trim().maxLength(60).optional(),
  status: vine.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
})
const listTenantsValidator = vine.create({
  q: vine.string().trim().maxLength(100).optional(),
  status: vine.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  limit: vine.number().withoutDecimals().min(1).max(100).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
})

const subscriptions = new PlatformSubscriptionService()
const tenants = new TenantRepository()
const id = (ctx: HttpContext, name = 'id') => {
  const value = ctx.params[name] as string
  if (!isUuid(value)) throw ApiError.notFound()
  return value
}
async function tenantOr404(tenantId: string) {
  const tenant = await tenants.find(tenantId)
  if (!tenant) throw ApiError.notFound()
  return tenant
}

/** Administração da plataforma (plano de controlo). Nunca lê dados de negócio dos tenants. */
export default class PlatformController {
  async features(ctx: HttpContext) {
    return ok(ctx, FEATURES)
  }

  async plans(ctx: HttpContext) {
    return ok(ctx, await subscriptions.listPlans())
  }

  async plan(ctx: HttpContext) {
    return ok(ctx, await subscriptions.getPlan(id(ctx)))
  }

  async createPlan(ctx: HttpContext) {
    const plan = await subscriptions.createPlan(
      await ctx.request.validateUsing(createPlanValidator)
    )
    return created(ctx, plan, `/api/v1/platform/plans/${plan.id}`)
  }

  async updatePlan(ctx: HttpContext) {
    return ok(
      ctx,
      await subscriptions.updatePlan(id(ctx), await ctx.request.validateUsing(updatePlanValidator))
    )
  }

  async publishPlan(ctx: HttpContext) {
    return ok(ctx, await subscriptions.setPlanStatus(id(ctx), 'ACTIVE'))
  }

  async retirePlan(ctx: HttpContext) {
    return ok(ctx, await subscriptions.setPlanStatus(id(ctx), 'RETIRED'))
  }

  async tenants(ctx: HttpContext) {
    const filter = await ctx.request.validateUsing(listTenantsValidator, { data: ctx.request.qs() })
    const page = await tenants.list({
      ...filter,
      limit: filter.limit ?? 50,
      offset: filter.offset ?? 0,
    })
    const items = await Promise.all(
      page.items.map(async (t) => ({
        ...t,
        subscriptionStatus: (await entitlementsFor(t.id)).status,
      }))
    )
    return ok(ctx, items, { total: page.total })
  }

  async createTenant(ctx: HttpContext) {
    const tenant = await createTenantWithAdmin(
      await ctx.request.validateUsing(createTenantValidator)
    )
    return created(ctx, tenant, `/api/v1/platform/tenants/${tenant.id}`)
  }

  async updateTenant(ctx: HttpContext) {
    const current = await tenantOr404(id(ctx))
    const { expectedVersion, status, ...rest } =
      await ctx.request.validateUsing(updateTenantValidator)
    const { values, issues } = normalizeTenant(rest, current)
    if (!values) throw ApiError.validation(issues)
    return ok(
      ctx,
      await tenants.update(current.id, expectedVersion, {
        ...values,
        status: status ?? current.status,
      })
    )
  }

  async subscription(ctx: HttpContext) {
    const tenant = await tenantOr404(id(ctx))
    return ok(ctx, await subscriptions.tenantSubscription(tenant.id))
  }

  async startSubscription(ctx: HttpContext) {
    const tenant = await tenantOr404(id(ctx))
    const body = await ctx.request.validateUsing(startValidator)
    const result = await subscriptions.start(tenant.id, body, ctx.authUser!.id)
    return created(ctx, result)
  }

  async transitionSubscription(ctx: HttpContext) {
    const { action, ...body } = await ctx.request.validateUsing(transitionValidator)
    return ok(ctx, await subscriptions.transition(id(ctx), action, body, ctx.authUser!.id))
  }

  async setOverride(ctx: HttpContext) {
    const tenant = await tenantOr404(id(ctx))
    const body = await ctx.request.validateUsing(overrideValidator)
    return ok(
      ctx,
      await subscriptions.setOverride(tenant.id, ctx.params.feature, body, ctx.authUser!.id)
    )
  }

  async removeOverride(ctx: HttpContext) {
    const tenant = await tenantOr404(id(ctx))
    return ok(ctx, await subscriptions.removeOverride(tenant.id, ctx.params.feature))
  }
}
