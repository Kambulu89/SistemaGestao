import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  DiscountLimitService,
  DiscountRuleService,
  PriceListService,
  PricingService,
} from '#modules/sales/application/pricing_service'
import { LIST_TARGETS, PRICING_STATUSES } from '#modules/sales/domain/pricing'

/** Preços e descontos (10.2): permissões `sales.prices.*` da empresa verificadas no serviço. */
const lists = new PriceListService()
const rules = new DiscountRuleService()
const limits = new DiscountLimitService()
const pricing = new PricingService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(PRICING_STATUSES).optional(),
    targetType: vine.enum(LIST_TARGETS).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const searchQuery = vine.create(vine.object({ q: vine.string().trim().maxLength(100).optional() }))
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const resolveBody = vine.create(
  vine.object({
    customerId: vine.string().trim(),
    currency: vine.string().trim().fixedLength(3),
    date: vine.string().trim().fixedLength(10),
    legalEntityId: vine.string().trim().uuid().nullable().optional(),
    lines: vine
      .array(
        vine.object({
          productId: vine.string().trim(),
          variantId: vine.string().trim().nullable().optional(),
          quantity: vine.string().trim().maxLength(30),
          manualDiscountPct: vine.string().trim().maxLength(10).nullable().optional(),
          manualUnitPrice: vine.string().trim().maxLength(30).nullable().optional(),
        })
      )
      .minLength(1)
      .maxLength(200),
  })
)
const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })
const page = async (ctx: HttpContext) => {
  const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
  return { ...q, limit: q.limit ?? 50, offset: q.offset ?? 0 }
}

export default class PricingController {
  async lists(ctx: HttpContext) {
    const p = await lists.list(ctx.tenantContext!, await page(ctx))
    return ok(ctx, p.items, { total: p.total })
  }
  async showList(ctx: HttpContext) {
    return ok(ctx, await lists.get(ctx.tenantContext!, param(ctx)))
  }
  async createList(ctx: HttpContext) {
    return created(ctx, await lists.create(ctx.tenantContext!, await body(ctx)))
  }
  async updateList(ctx: HttpContext) {
    return ok(ctx, await lists.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async addLine(ctx: HttpContext) {
    return ok(ctx, await lists.addLine(ctx.tenantContext!, param(ctx), await body(ctx)))
  }
  async updateLine(ctx: HttpContext) {
    return ok(
      ctx,
      await lists.updateLine(ctx.tenantContext!, param(ctx), param(ctx, 'lineId'), await vbody(ctx))
    )
  }
  async removeLine(ctx: HttpContext) {
    return ok(ctx, await lists.removeLine(ctx.tenantContext!, param(ctx), param(ctx, 'lineId')))
  }
  async submitList(ctx: HttpContext) {
    return ok(ctx, await lists.submit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async approveList(ctx: HttpContext) {
    return ok(ctx, await lists.approve(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async rejectList(ctx: HttpContext) {
    return ok(ctx, await lists.reject(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async deactivateList(ctx: HttpContext) {
    return ok(ctx, await lists.deactivate(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async copyList(ctx: HttpContext) {
    return created(ctx, await lists.copy(ctx.tenantContext!, param(ctx), await body(ctx)))
  }

  async rules(ctx: HttpContext) {
    const p = await rules.list(ctx.tenantContext!, await page(ctx))
    return ok(ctx, p.items, { total: p.total })
  }
  async showRule(ctx: HttpContext) {
    return ok(ctx, await rules.get(ctx.tenantContext!, param(ctx)))
  }
  async createRule(ctx: HttpContext) {
    return created(ctx, await rules.create(ctx.tenantContext!, await body(ctx)))
  }
  async updateRule(ctx: HttpContext) {
    return ok(ctx, await rules.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async submitRule(ctx: HttpContext) {
    return ok(ctx, await rules.submit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async approveRule(ctx: HttpContext) {
    return ok(ctx, await rules.approve(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async rejectRule(ctx: HttpContext) {
    return ok(ctx, await rules.reject(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async deactivateRule(ctx: HttpContext) {
    return ok(ctx, await rules.deactivate(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async limits(ctx: HttpContext) {
    return ok(ctx, await limits.list(ctx.tenantContext!))
  }
  async setLimit(ctx: HttpContext) {
    return ok(ctx, await limits.set(ctx.tenantContext!, await body(ctx)))
  }
  async removeLimit(ctx: HttpContext) {
    return ok(ctx, await limits.remove(ctx.tenantContext!, param(ctx)))
  }

  async resolve(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(resolveBody, { data: ctx.request.body() })
    return ok(ctx, await pricing.resolve(ctx.tenantContext!, input))
  }
  async searchCustomers(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await pricing.search(ctx.tenantContext!, 'customers', q ?? ''))
  }
  async searchProducts(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await pricing.search(ctx.tenantContext!, 'products', q ?? ''))
  }

  async options(ctx: HttpContext) {
    return ok(ctx, await pricing.options(ctx.tenantContext!))
  }
}
