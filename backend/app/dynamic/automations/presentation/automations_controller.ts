import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { automationServices } from '#dynamic/automations/presentation/composition'
import {
  createAutomationValidator,
  listRunsValidator,
  simulateValidator,
  updateAutomationValidator,
  versionOnlyValidator,
} from '#dynamic/automations/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class AutomationsController {
  async catalog(ctx: HttpContext) {
    return envelope(ctx, automationServices().automations.catalog())
  }

  async list(ctx: HttpContext) {
    return envelope(ctx, await automationServices().automations.list(ctx.tenantContext))
  }

  async show(ctx: HttpContext) {
    return envelope(
      ctx,
      await automationServices().automations.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async create(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createAutomationValidator)
    const created = await automationServices().automations.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/automations/${created.id}`)
    return envelope(ctx, created)
  }

  async update(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateAutomationValidator)
    return envelope(
      ctx,
      await automationServices().automations.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async activate(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await automationServices().automations.activate(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }

  async pause(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await automationServices().automations.pause(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }

  async simulate(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(simulateValidator)
    return envelope(
      ctx,
      await automationServices().automations.simulate(ctx.tenantContext, uuidParam(ctx, 'id'), {
        payload: b.payload,
        scheduledFor: b.scheduledFor,
      })
    )
  }

  async listRuns(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listRunsValidator, { data: ctx.request.qs() })
    return envelope(ctx, await automationServices().runs.list(ctx.tenantContext, q))
  }

  async showRun(ctx: HttpContext) {
    return envelope(
      ctx,
      await automationServices().runs.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async retryRun(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await automationServices().runs.retry(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }
}
