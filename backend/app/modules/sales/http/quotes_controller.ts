import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { QuoteService } from '#modules/sales/application/quote_service'
import { QUOTE_STATUSES } from '#modules/sales/domain/quotes'

/** Orçamentos (10.3): âmbito RBAC de `sales.quotes.*` (empresa, entidade legal ou próprios) verificado no serviço. */
const quotes = new QuoteService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum([...QUOTE_STATUSES, 'EXPIRED']).optional(),
    customerId: vine.string().uuid().optional(),
    legalEntityId: vine.string().uuid().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const searchQuery = vine.create(vine.object({ q: vine.string().trim().maxLength(100).optional() }))
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class QuotesController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await quotes.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
  async options(ctx: HttpContext) {
    return ok(ctx, await quotes.options(ctx.tenantContext!))
  }
  async searchCustomers(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await quotes.search(ctx.tenantContext!, 'customers', q ?? ''))
  }
  async searchProducts(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await quotes.search(ctx.tenantContext!, 'products', q ?? ''))
  }
  async show(ctx: HttpContext) {
    return ok(ctx, await quotes.get(ctx.tenantContext!, param(ctx)))
  }
  async store(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(ctx, await quotes.create(ctx.tenantContext!, body))
  }
  async update(ctx: HttpContext) {
    return ok(ctx, await quotes.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async submit(ctx: HttpContext) {
    return ok(ctx, await quotes.submit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async approve(ctx: HttpContext) {
    return ok(ctx, await quotes.approve(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async reject(ctx: HttpContext) {
    return ok(ctx, await quotes.reject(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async send(ctx: HttpContext) {
    return ok(ctx, await quotes.send(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async accept(ctx: HttpContext) {
    return ok(ctx, await quotes.accept(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async decline(ctx: HttpContext) {
    return ok(ctx, await quotes.decline(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async revise(ctx: HttpContext) {
    return ok(ctx, await quotes.revise(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async cancel(ctx: HttpContext) {
    return ok(ctx, await quotes.cancel(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
