import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { RECEIPT_STATUSES, ReceiptService } from '#modules/sales/application/receipt_service'

/** Recebimentos (10.7): âmbito RBAC de `sales.receipts.*` por entidade legal, verificado no serviço. */
const receipts = new ReceiptService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(RECEIPT_STATUSES).optional(),
    customerId: vine.string().uuid().optional(),
    advances: vine.boolean().optional(),
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
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class SalesReceiptsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await receipts.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
  async options(ctx: HttpContext) {
    return ok(ctx, await receipts.options(ctx.tenantContext!))
  }
  async searchCustomers(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await receipts.search(ctx.tenantContext!, q ?? ''))
  }
  async openItems(ctx: HttpContext) {
    return ok(
      ctx,
      await receipts.openItems(
        ctx.tenantContext!,
        param(ctx, 'legalEntityId'),
        param(ctx, 'customerId')
      )
    )
  }
  async show(ctx: HttpContext) {
    return ok(ctx, await receipts.get(ctx.tenantContext!, param(ctx)))
  }
  async store(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(ctx, await receipts.register(ctx.tenantContext!, body))
  }
  async confirm(ctx: HttpContext) {
    return ok(ctx, await receipts.confirm(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async reject(ctx: HttpContext) {
    return ok(
      ctx,
      await receipts.decide(ctx.tenantContext!, param(ctx), await vbody(ctx), 'reject')
    )
  }
  async cancel(ctx: HttpContext) {
    return ok(
      ctx,
      await receipts.decide(ctx.tenantContext!, param(ctx), await vbody(ctx), 'cancel')
    )
  }
  async applyAdvance(ctx: HttpContext) {
    return ok(ctx, await receipts.applyAdvance(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
