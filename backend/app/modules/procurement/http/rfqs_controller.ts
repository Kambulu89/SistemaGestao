import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { RfqService } from '#modules/procurement/application/rfq_service'
import { RFQ_STATUSES } from '#modules/procurement/domain/rfqs'

/** Pedidos de cotação (9.3): âmbito por entidade verificado no serviço (`procurement.rfqs.read|manage`). */
const rfqs = new RfqService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(RFQ_STATUSES).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class RfqsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await rfqs.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async options(ctx: HttpContext) {
    return ok(ctx, await rfqs.options(ctx.tenantContext!))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await rfqs.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await rfqs.create(ctx.tenantContext!, await body(ctx)))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await rfqs.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async invite(ctx: HttpContext) {
    return ok(ctx, await rfqs.invite(ctx.tenantContext!, param(ctx), await body(ctx)))
  }

  async uninvite(ctx: HttpContext) {
    return ok(ctx, await rfqs.uninvite(ctx.tenantContext!, param(ctx)))
  }

  async decline(ctx: HttpContext) {
    return ok(ctx, await rfqs.decline(ctx.tenantContext!, param(ctx), await body(ctx)))
  }

  async issue(ctx: HttpContext) {
    return ok(ctx, await rfqs.issue(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async amend(ctx: HttpContext) {
    return ok(ctx, await rfqs.amend(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async quote(ctx: HttpContext) {
    return created(ctx, await rfqs.registerQuote(ctx.tenantContext!, param(ctx), await body(ctx)))
  }

  async withdraw(ctx: HttpContext) {
    return ok(ctx, await rfqs.withdrawQuote(ctx.tenantContext!, param(ctx), await body(ctx)))
  }

  async open(ctx: HttpContext) {
    return ok(ctx, await rfqs.open(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async cancel(ctx: HttpContext) {
    return ok(ctx, await rfqs.cancel(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
