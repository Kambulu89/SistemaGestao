import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { EvaluationService } from '#modules/procurement/application/evaluation_service'

/**
 * Avaliação de fornecedores (9.11): âmbito verificado no serviço (`procurement.evaluations.*`); pesos com
 * `procurement.settings` (rota).
 */
const evaluations = new EvaluationService()

const periodQuery = vine.create(
  vine.object({
    from: vine.string().trim().maxLength(10),
    to: vine.string().trim().maxLength(10).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })

export default class EvaluationsController {
  async ranking(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(periodQuery, { data: ctx.request.qs() })
    return ok(ctx, await evaluations.ranking(ctx.tenantContext!, q))
  }

  async supplier(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(periodQuery, { data: ctx.request.qs() })
    return ok(ctx, await evaluations.supplier(ctx.tenantContext!, param(ctx), q))
  }

  async publish(ctx: HttpContext) {
    return created(ctx, await evaluations.publish(ctx.tenantContext!, param(ctx), await body(ctx)))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await evaluations.get(ctx.tenantContext!, param(ctx)))
  }

  async weights(ctx: HttpContext) {
    return ok(ctx, await evaluations.weights(ctx.tenantContext!))
  }

  async setWeights(ctx: HttpContext) {
    return ok(ctx, await evaluations.setWeights(ctx.tenantContext!, await body(ctx)))
  }
}
