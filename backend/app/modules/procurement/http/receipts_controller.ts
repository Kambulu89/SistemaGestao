import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { ReceiptService } from '#modules/procurement/application/receipt_service'
import { RECEIPT_STATUSES } from '#modules/procurement/domain/receipts'

/** Recepções de compra (9.7): âmbito por entidade verificado no serviço (`procurement.receipts.read|manage`). */
const receipts = new ReceiptService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(RECEIPT_STATUSES).optional(),
    orderId: vine.string().uuid().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const expectedQuery = vine.create(
  vine.object({
    state: vine.enum(['OVERDUE', 'TODAY', 'UPCOMING', 'UNSCHEDULED']).optional(),
    limit: vine.number().withoutDecimals().min(1).max(500).optional(),
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

export default class ReceiptsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await receipts.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async expected(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(expectedQuery, { data: ctx.request.qs() })
    return ok(ctx, await receipts.expected(ctx.tenantContext!, { ...q, limit: q.limit ?? 300 }))
  }

  async order(ctx: HttpContext) {
    return ok(ctx, await receipts.receivableOrder(ctx.tenantContext!, param(ctx)))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await receipts.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await receipts.create(ctx.tenantContext!, await body(ctx)))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await receipts.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async confirm(ctx: HttpContext) {
    return ok(ctx, await receipts.confirm(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async cancel(ctx: HttpContext) {
    return ok(ctx, await receipts.cancel(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async reverse(ctx: HttpContext) {
    return ok(ctx, await receipts.reverse(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
