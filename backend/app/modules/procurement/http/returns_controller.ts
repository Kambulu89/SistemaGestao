import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { ReturnService } from '#modules/procurement/application/return_service'
import { CREDIT_STATUSES, RETURN_STATUSES } from '#modules/procurement/domain/returns'

/** Devoluções a fornecedor e não conformidades (9.9): âmbito por entidade verificado no serviço. */
const returns = new ReturnService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(RETURN_STATUSES).optional(),
    creditStatus: vine.enum(CREDIT_STATUSES).optional(),
    receiptId: vine.string().uuid().optional(),
    orderId: vine.string().uuid().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const receiptQuery = vine.create(vine.object({ exceptReturnId: vine.string().uuid().optional() }))
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

export default class ReturnsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await returns.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async receipt(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(receiptQuery, { data: ctx.request.qs() })
    return ok(
      ctx,
      await returns.returnableReceipt(ctx.tenantContext!, param(ctx), q.exceptReturnId ?? null)
    )
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await returns.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(ctx, await returns.create(ctx.tenantContext!, b))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await returns.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async confirm(ctx: HttpContext) {
    return ok(ctx, await returns.confirm(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async cancel(ctx: HttpContext) {
    return ok(ctx, await returns.cancel(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
