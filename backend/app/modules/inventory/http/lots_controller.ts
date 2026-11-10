import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { LotService } from '#modules/inventory/application/lot_service'
import { LOT_STATUSES } from '#modules/inventory/domain/lots'

/**
 * Lotes e séries (8.8): consulta com `inventory.read` (movimentos e saldos só dos armazéns consultáveis), bloqueio,
 * desbloqueio e recolha com `inventory.lots.manage` no âmbito de todos os armazéns do lote — verificados no serviço.
 */
const lots = new LotService()

const listQuery = vine.create(
  vine.object({
    productId: vine.string().uuid().optional(),
    status: vine.enum(LOT_STATUSES).optional(),
    q: vine.string().trim().maxLength(100).optional(),
    expiringWithinDays: vine.number().withoutDecimals().min(0).max(3650).optional(),
    withStock: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const serialQuery = vine.create(
  vine.object({
    productId: vine.string().uuid().optional(),
    q: vine.string().trim().maxLength(100).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(0) }).allowUnknownProperties()
)
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() }) as Promise<any>

export default class LotsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await lots.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await lots.get(ctx.tenantContext!, param(ctx)))
  }

  async block(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx)
    return ok(ctx, await lots.block(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async unblock(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx)
    return ok(ctx, await lots.unblock(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async recall(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx)
    return ok(ctx, await lots.recall(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async serials(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(serialQuery, { data: ctx.request.qs() })
    const p = await lots.serials(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async serial(ctx: HttpContext) {
    return ok(ctx, await lots.serial(ctx.tenantContext!, param(ctx)))
  }
}
