import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { InvoiceService } from '#modules/sales/application/invoice_service'
import { INVOICE_STATUSES } from '#modules/sales/domain/invoices'

/** Facturas (10.6): âmbito RBAC de `sales.invoices.*` por entidade legal, verificado no serviço. */
const invoices = new InvoiceService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(INVOICE_STATUSES).optional(),
    fiscalStatus: vine.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'CONTINGENCY']).optional(),
    collection: vine.enum(['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE']).optional(),
    customerId: vine.string().uuid().optional(),
    orderId: vine.string().uuid().optional(),
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

export default class SalesInvoicesController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await invoices.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
  async options(ctx: HttpContext) {
    return ok(ctx, await invoices.options(ctx.tenantContext!))
  }
  async searchCustomers(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await invoices.search(ctx.tenantContext!, 'customers', q ?? ''))
  }
  async searchProducts(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await invoices.search(ctx.tenantContext!, 'products', q ?? ''))
  }
  async orderDraft(ctx: HttpContext) {
    return ok(ctx, await invoices.orderDraft(ctx.tenantContext!, param(ctx, 'orderId')))
  }
  async show(ctx: HttpContext) {
    return ok(ctx, await invoices.get(ctx.tenantContext!, param(ctx)))
  }
  async store(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(ctx, await invoices.create(ctx.tenantContext!, body))
  }
  async update(ctx: HttpContext) {
    return ok(ctx, await invoices.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async issue(ctx: HttpContext) {
    return ok(ctx, await invoices.issue(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async discard(ctx: HttpContext) {
    return ok(ctx, await invoices.discard(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
