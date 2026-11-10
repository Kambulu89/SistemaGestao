import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { CountService } from '#modules/inventory/application/count_service'
import { COUNT_STATUSES } from '#modules/inventory/domain/counts'

/**
 * Contagens físicas e ajustes (8.7): âmbito de inventory.counts.manage (com acesso de operação) e
 * inventory.counts.approve sobre o armazém (entidade legal ou filial) — verificados no serviço.
 */
const counts = new CountService()

const listQuery = vine.create(
  vine.object({
    status: vine.enum(COUNT_STATUSES).optional(),
    warehouseId: vine.string().uuid().optional(),
    q: vine.string().trim().maxLength(100).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(0) }).allowUnknownProperties()
)
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class CountsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await counts.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async options(ctx: HttpContext) {
    return ok(ctx, await counts.options(ctx.tenantContext!))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await counts.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await counts.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await counts.update(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async start(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(ctx, await counts.start(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async count(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await counts.count(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async addLine(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await counts.addLine(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async submit(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(ctx, await counts.submit(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async justify(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await counts.justify(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async recount(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await counts.recount(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async approve(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(ctx, await counts.approve(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await counts.cancel(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }
}
