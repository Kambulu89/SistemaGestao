import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { StockService } from '#modules/inventory/application/stock_service'
import { POSTING_TYPES } from '#modules/inventory/domain/stock'

/**
 * Stock (8.3): consulta de saldos, movimentos e lançamentos limitada aos armazéns que o membro pode consultar;
 * mudança de estado com `inventory.stock.manage` no âmbito do armazém e acesso de operação — verificados no serviço.
 */
const stock = new StockService()

const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}
const balancesQuery = vine.create(
  vine.object({
    warehouseId: vine.string().uuid().optional(),
    productId: vine.string().uuid().optional(),
    q: vine.string().trim().maxLength(100).optional(),
    nonZero: vine.boolean().optional(),
    ...page,
  })
)
const movementsQuery = vine.create(
  vine.object({
    warehouseId: vine.string().uuid().optional(),
    productId: vine.string().uuid().optional(),
    variantId: vine.string().uuid().optional(),
    type: vine.enum(POSTING_TYPES).optional(),
    ...page,
  })
)
const reconQuery = vine.create(vine.object({ warehouseId: vine.string().uuid().optional() }))
const statusBody = vine.create(
  vine.object({
    warehouseId: vine.string().uuid(),
    locationId: vine.string().uuid().nullable().optional(),
    productId: vine.string().uuid(),
    variantId: vine.string().uuid().nullable().optional(),
    from: vine.string().trim().maxLength(12),
    to: vine.string().trim().maxLength(12),
    quantity: vine.string().trim().maxLength(30),
    reason: vine.string().trim().maxLength(300),
    idempotencyKey: vine.string().trim().maxLength(100),
  })
)

export default class StockController {
  async balances(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(balancesQuery, { data: ctx.request.qs() })
    const p = await stock.balances(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async movements(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(movementsQuery, { data: ctx.request.qs() })
    const p = await stock.movements(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async posting(ctx: HttpContext) {
    const id = ctx.params.id as string
    if (!isUuid(id)) throw ApiError.notFound()
    return ok(ctx, await stock.posting(ctx.tenantContext!, id))
  }

  async changeStatus(ctx: HttpContext) {
    const v = await ctx.request.validateUsing(statusBody, { data: ctx.request.body() })
    return created(ctx, await stock.changeStatus(ctx.tenantContext!, v))
  }

  async reconciliation(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(reconQuery, { data: ctx.request.qs() })
    return ok(ctx, await stock.reconciliation(ctx.tenantContext!, q))
  }
}
