import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { OrderService } from '#modules/sales/application/order_service'
import { ORDER_STATUSES } from '#modules/sales/domain/orders'

/** Encomendas (10.4): âmbito RBAC de `sales.orders.*` (empresa, entidade legal ou próprias) verificado no serviço. */
const orders = new OrderService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(ORDER_STATUSES).optional(),
    approvalStatus: vine.enum(['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED']).optional(),
    deliveryStatus: vine.enum(['NONE', 'PARTIAL', 'FULL']).optional(),
    customerId: vine.string().uuid().optional(),
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

export default class OrdersController {
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
  async addresses(ctx: HttpContext) {
    return ok(ctx, await orders.addresses(ctx.tenantContext!, param(ctx, 'customerId')))
  }
  async searchCustomers(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await orders.search(ctx.tenantContext!, 'customers', q ?? ''))
  }
  async searchProducts(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await orders.search(ctx.tenantContext!, 'products', q ?? ''))
  }
  async show(ctx: HttpContext) {
    return ok(ctx, await orders.get(ctx.tenantContext!, param(ctx)))
  }
  async store(ctx: HttpContext) {
    return created(ctx, await orders.create(ctx.tenantContext!, await body(ctx)))
  }
  async fromQuote(ctx: HttpContext) {
    return created(ctx, await orders.fromQuote(ctx.tenantContext!, await body(ctx)))
  }
  async update(ctx: HttpContext) {
    return ok(ctx, await orders.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async submit(ctx: HttpContext) {
    return ok(ctx, await orders.submit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async approve(ctx: HttpContext) {
    return ok(ctx, await orders.approve(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async reject(ctx: HttpContext) {
    return ok(ctx, await orders.reject(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async reserve(ctx: HttpContext) {
    return ok(ctx, await orders.reserve(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async release(ctx: HttpContext) {
    return ok(ctx, await orders.release(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async deliver(ctx: HttpContext) {
    return ok(ctx, await orders.deliver(ctx.tenantContext!, param(ctx), await body(ctx)))
  }
  async close(ctx: HttpContext) {
    return ok(ctx, await orders.close(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async cancel(ctx: HttpContext) {
    return ok(ctx, await orders.cancel(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
