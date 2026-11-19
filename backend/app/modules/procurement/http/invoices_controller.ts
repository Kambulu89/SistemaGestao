import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { InvoiceService } from '#modules/procurement/application/invoice_service'
import { INVOICE_STATUSES } from '#modules/procurement/domain/invoices'

/**
 * Facturas de fornecedor (9.8): âmbito por entidade verificado no serviço (`procurement.invoices.*`). Tolerâncias:
 * ler na sessão da empresa; alterar com `procurement.settings` (rota).
 */
const invoices = new InvoiceService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(INVOICE_STATUSES).optional(),
    orderId: vine.string().uuid().optional(),
    supplierId: vine.string().uuid().optional(),
    divergent: vine.boolean().optional(),
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

export default class InvoicesController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await invoices.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async order(ctx: HttpContext) {
    return ok(ctx, await invoices.invoiceableOrder(ctx.tenantContext!, param(ctx)))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await invoices.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await invoices.create(ctx.tenantContext!, await body(ctx)))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await invoices.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async validate(ctx: HttpContext) {
    return ok(ctx, await invoices.validate(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async approve(ctx: HttpContext) {
    return ok(
      ctx,
      await invoices.decide(ctx.tenantContext!, param(ctx), 'approve', await vbody(ctx))
    )
  }

  async reject(ctx: HttpContext) {
    return ok(
      ctx,
      await invoices.decide(ctx.tenantContext!, param(ctx), 'reject', await vbody(ctx))
    )
  }

  async refuse(ctx: HttpContext) {
    return ok(ctx, await invoices.close(ctx.tenantContext!, param(ctx), 'refuse', await vbody(ctx)))
  }

  async cancel(ctx: HttpContext) {
    return ok(ctx, await invoices.close(ctx.tenantContext!, param(ctx), 'cancel', await vbody(ctx)))
  }

  async tolerances(ctx: HttpContext) {
    return ok(ctx, await invoices.tolerances(ctx.tenantContext!))
  }

  async setTolerances(ctx: HttpContext) {
    return ok(ctx, await invoices.setTolerances(ctx.tenantContext!, await body(ctx)))
  }
}
