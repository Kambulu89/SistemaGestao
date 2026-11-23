import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { CustomerService, SegmentService } from '#modules/sales/application/customer_service'
import { CUSTOMER_STATUSES } from '#modules/sales/domain/customers'

/**
 * Clientes (10.1): permissões da empresa verificadas no serviço (`sales.customers.*`); segmentos: ler com a sessão
 * de quem vê clientes, alterar com `sales.settings` (rota).
 */
const customers = new CustomerService()
const segments = new SegmentService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(CUSTOMER_STATUSES).optional(),
    segmentId: vine.string().uuid().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const lookupQuery = vine.create(
  vine.object({
    countryCode: vine.string().trim().fixedLength(2),
    taxId: vine.string().trim().minLength(5).maxLength(30),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const uuidParam = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class CustomersController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await customers.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async lookup(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(lookupQuery, { data: ctx.request.qs() })
    return ok(ctx, await customers.lookup(ctx.tenantContext!, q.countryCode, q.taxId))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await customers.get(ctx.tenantContext!, uuidParam(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await customers.create(ctx.tenantContext!, await body(ctx)))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await customers.update(ctx.tenantContext!, uuidParam(ctx), await vbody(ctx)))
  }

  async credit(ctx: HttpContext) {
    return ok(ctx, await customers.setCredit(ctx.tenantContext!, uuidParam(ctx), await vbody(ctx)))
  }

  async status(ctx: HttpContext) {
    return ok(ctx, await customers.setStatus(ctx.tenantContext!, uuidParam(ctx), await vbody(ctx)))
  }

  async addAddress(ctx: HttpContext) {
    return created(
      ctx,
      await customers.addAddress(ctx.tenantContext!, uuidParam(ctx), await body(ctx))
    )
  }

  async updateAddress(ctx: HttpContext) {
    return ok(
      ctx,
      await customers.updateAddress(
        ctx.tenantContext!,
        uuidParam(ctx),
        uuidParam(ctx, 'addressId'),
        await vbody(ctx)
      )
    )
  }

  async addContact(ctx: HttpContext) {
    return created(
      ctx,
      await customers.addContact(ctx.tenantContext!, uuidParam(ctx), await body(ctx))
    )
  }

  async updateContact(ctx: HttpContext) {
    return ok(
      ctx,
      await customers.updateContact(
        ctx.tenantContext!,
        uuidParam(ctx),
        uuidParam(ctx, 'contactId'),
        await vbody(ctx)
      )
    )
  }

  async currentVersion(ctx: HttpContext) {
    return ok(ctx, await customers.currentVersion(ctx.tenantContext!, uuidParam(ctx)))
  }

  async segments(ctx: HttpContext) {
    return ok(ctx, await segments.list(ctx.tenantContext!))
  }

  async createSegment(ctx: HttpContext) {
    return created(ctx, await segments.create(ctx.tenantContext!, await body(ctx)))
  }

  async updateSegment(ctx: HttpContext) {
    return ok(ctx, await segments.update(ctx.tenantContext!, uuidParam(ctx), await vbody(ctx)))
  }
}
