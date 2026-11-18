import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { PurchaseOrderService } from '#modules/procurement/application/order_service'
import {
  APPROVAL_STATUSES,
  INVOICE_STATUSES,
  RECEIPT_STATUSES,
} from '#modules/procurement/domain/orders'

/** Ordens de compra (9.5): âmbito por entidade verificado no serviço (`procurement.orders.read|manage|approve`). */
const orders = new PurchaseOrderService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    approvalStatus: vine.enum(APPROVAL_STATUSES).optional(),
    receiptStatus: vine.enum(RECEIPT_STATUSES).optional(),
    invoiceStatus: vine.enum(INVOICE_STATUSES).optional(),
    supplierId: vine.string().uuid().optional(),
    awaitingMe: vine.boolean().optional(),
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

export default class PurchaseOrdersController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await orders.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async options(ctx: HttpContext) {
    return ok(ctx, await orders.options(ctx.tenantContext!))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await orders.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await orders.create(ctx.tenantContext!, await body(ctx)))
  }

  async fromAward(ctx: HttpContext) {
    return created(ctx, { ids: await orders.fromAward(ctx.tenantContext!, param(ctx)) })
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await orders.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async submit(ctx: HttpContext) {
    return ok(ctx, await orders.submit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async approve(ctx: HttpContext) {
    return ok(ctx, await orders.decide(ctx.tenantContext!, param(ctx), 'approve', await vbody(ctx)))
  }

  async reject(ctx: HttpContext) {
    return ok(ctx, await orders.decide(ctx.tenantContext!, param(ctx), 'reject', await vbody(ctx)))
  }

  async issue(ctx: HttpContext) {
    return ok(ctx, await orders.issue(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async revise(ctx: HttpContext) {
    return ok(ctx, await orders.revise(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async cancel(ctx: HttpContext) {
    return ok(ctx, await orders.cancel(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async close(ctx: HttpContext) {
    return ok(ctx, await orders.close(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
