import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { RecurringService } from '#modules/sales/application/recurring_service'
import { CONTRACT_STATUSES } from '#modules/sales/domain/recurring'

/** Facturação recorrente (10.11): âmbito de `sales.recurring.*` por entidade legal, verificado no serviço. */
const recurring = new RecurringService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(CONTRACT_STATUSES).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const searchQuery = vine.create(vine.object({ q: vine.string().trim().maxLength(100).optional() }))
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class RecurringController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await recurring.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
  async options(ctx: HttpContext) {
    return ok(ctx, await recurring.options(ctx.tenantContext!))
  }
  async searchCustomers(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await recurring.search(ctx.tenantContext!, 'customers', q ?? ''))
  }
  async searchProducts(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await recurring.search(ctx.tenantContext!, 'products', q ?? ''))
  }
  async store(ctx: HttpContext) {
    return created(ctx, await recurring.create(ctx.tenantContext!, await body(ctx)))
  }
  async show(ctx: HttpContext) {
    return ok(ctx, await recurring.get(ctx.tenantContext!, param(ctx)))
  }
  async update(ctx: HttpContext) {
    return ok(ctx, await recurring.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async addVersion(ctx: HttpContext) {
    return created(ctx, await recurring.addVersion(ctx.tenantContext!, param(ctx), await body(ctx)))
  }
  async updateVersion(ctx: HttpContext) {
    return ok(ctx, await recurring.updateVersion(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async approveVersion(ctx: HttpContext) {
    return ok(ctx, await recurring.approveVersion(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async discardVersion(ctx: HttpContext) {
    return ok(ctx, await recurring.discardVersion(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async activate(ctx: HttpContext) {
    return ok(
      ctx,
      await recurring.transition(ctx.tenantContext!, param(ctx), await vbody(ctx), 'activate')
    )
  }
  async suspend(ctx: HttpContext) {
    return ok(
      ctx,
      await recurring.transition(ctx.tenantContext!, param(ctx), await vbody(ctx), 'suspend')
    )
  }
  async resume(ctx: HttpContext) {
    return ok(
      ctx,
      await recurring.transition(ctx.tenantContext!, param(ctx), await vbody(ctx), 'resume')
    )
  }
  async end(ctx: HttpContext) {
    return ok(
      ctx,
      await recurring.transition(ctx.tenantContext!, param(ctx), await vbody(ctx), 'end')
    )
  }
  async generate(ctx: HttpContext) {
    return ok(ctx, await recurring.generate(ctx.tenantContext!, param(ctx)))
  }
  async generateAll(ctx: HttpContext) {
    return ok(ctx, await recurring.generateAll(ctx.tenantContext!))
  }
}
