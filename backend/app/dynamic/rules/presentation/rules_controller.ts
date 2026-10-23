import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { ruleServices } from '#dynamic/rules/presentation/composition'
import {
  createRuleValidator,
  listRulesValidator,
  simulateValidator,
  updateRuleValidator,
  versionOnlyValidator,
} from '#dynamic/rules/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class RulesController {
  async list(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listRulesValidator, { data: ctx.request.qs() })
    return envelope(ctx, await ruleServices().rules.list(ctx.tenantContext, q))
  }

  async show(ctx: HttpContext) {
    return envelope(ctx, await ruleServices().rules.get(ctx.tenantContext, idParam(ctx)))
  }

  async create(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createRuleValidator)
    const rule = await ruleServices().rules.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/rules/${rule.id}`)
    return envelope(ctx, rule)
  }

  async update(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateRuleValidator)
    return envelope(ctx, await ruleServices().rules.update(ctx.tenantContext, idParam(ctx), b))
  }

  async createRevision(ctx: HttpContext) {
    const rule = await ruleServices().rules.createRevision(ctx.tenantContext, idParam(ctx))
    ctx.response.status(201).header('location', `/api/v1/rules/${rule.id}`)
    return envelope(ctx, rule)
  }

  async publish(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await ruleServices().rules.publish(ctx.tenantContext, idParam(ctx), b.expectedVersion)
    )
  }

  async disable(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await ruleServices().rules.disable(ctx.tenantContext, idParam(ctx), b.expectedVersion)
    )
  }

  async simulate(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(simulateValidator)
    if (typeof b.values !== 'object' || b.values === null || Array.isArray(b.values)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
        { path: 'values', code: 'INVALID_VALUES', message: 'values tem de ser um objecto.' },
      ])
    }
    return envelope(
      ctx,
      await ruleServices().rules.simulate(ctx.tenantContext, idParam(ctx), {
        values: b.values as Record<string, unknown>,
        now: b.now,
      })
    )
  }

  async evaluations(ctx: HttpContext) {
    return envelope(ctx, await ruleServices().rules.evaluations(ctx.tenantContext, idParam(ctx)))
  }
}
