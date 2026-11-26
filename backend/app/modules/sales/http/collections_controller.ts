import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { CollectionService } from '#modules/sales/application/collection_service'

/** Cobranças (10.10): âmbito de `sales.collections.read|manage` por entidade legal, verificado no serviço. */
const collections = new CollectionService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    legalEntityId: vine.string().uuid().optional(),
    overdue: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}

export default class CollectionsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await collections.worklist(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
  async show(ctx: HttpContext) {
    return ok(ctx, await collections.statement(ctx.tenantContext!, param(ctx, 'customerId')))
  }
  async storePromise(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(
      ctx,
      await collections.createPromise(ctx.tenantContext!, param(ctx, 'customerId'), b)
    )
  }
  async cancelPromise(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versioned, { data: ctx.request.body() })
    return ok(ctx, await collections.cancelPromise(ctx.tenantContext!, param(ctx), b))
  }
  async storeActivity(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(
      ctx,
      await collections.addActivity(ctx.tenantContext!, param(ctx, 'customerId'), b)
    )
  }
}
