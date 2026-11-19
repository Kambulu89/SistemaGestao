import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { ValuationService } from '#modules/inventory/application/valuation_service'

/**
 * Valorização (8.9): `inventory.valuation.read` (consulta, livro, reconciliação) e `inventory.valuation.manage` (ajustes
 * de custo, contas da reconciliação), no âmbito da entidade legal — verificados no serviço.
 */
const valuation = new ValuationService()

const listQuery = vine.create(
  vine.object({
    legalEntityId: vine.string().uuid().optional(),
    productId: vine.string().uuid().optional(),
    q: vine.string().trim().maxLength(100).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const leQuery = vine.create(vine.object({ legalEntityId: vine.string().uuid() }))
const reconQuery = vine.create(
  vine.object({
    legalEntityId: vine.string().uuid(),
    date: vine.string().trim().maxLength(10).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}

export default class ValuationController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await valuation.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total, totals: p.totals })
  }

  async product(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(leQuery, { data: ctx.request.qs() })
    return ok(ctx, await valuation.product(ctx.tenantContext!, param(ctx), q.legalEntityId))
  }

  async adjust(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(ctx, await valuation.adjust(ctx.tenantContext!, b))
  }

  async reconciliation(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(reconQuery, { data: ctx.request.qs() })
    return ok(ctx, await valuation.reconciliation(ctx.tenantContext!, q.legalEntityId, q.date))
  }

  async accounts(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(leQuery, { data: ctx.request.qs() })
    return ok(ctx, await valuation.accounts(ctx.tenantContext!, q.legalEntityId))
  }

  async setAccounts(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(leQuery, { data: ctx.request.qs() })
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return ok(ctx, await valuation.setAccounts(ctx.tenantContext!, q.legalEntityId, b))
  }
}
