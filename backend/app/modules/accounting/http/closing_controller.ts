import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { ClosingService } from '#modules/accounting/application/closing_service'

/** Fecho (6.10): checklist e tarefas por período, fecho de período, encerramento e reabertura do exercício. */
const closing = new ClosingService()

const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const closeValidator = vine.create(
  vine.object({
    acknowledgeWarnings: vine.boolean().optional(),
    reason: vine.string().trim().maxLength(500).optional(),
  })
)

const uuid = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}

export default class ClosingController {
  async checklist(ctx: HttpContext) {
    return ok(ctx, await closing.checklist(ctx.tenantContext!, uuid(ctx)))
  }

  async closePeriod(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(closeValidator)
    return ok(ctx, await closing.closePeriod(ctx.tenantContext!, uuid(ctx), body))
  }

  async addTask(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await closing.addTask(ctx.tenantContext!, uuid(ctx), body))
  }

  async copyTasks(ctx: HttpContext) {
    return ok(ctx, await closing.copyTasks(ctx.tenantContext!, uuid(ctx)))
  }

  async updateTask(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return ok(ctx, await closing.updateTask(ctx.tenantContext!, uuid(ctx), body))
  }

  async deleteTask(ctx: HttpContext) {
    await closing.deleteTask(ctx.tenantContext!, uuid(ctx))
    return ctx.response.noContent()
  }

  async yearStatus(ctx: HttpContext) {
    return ok(ctx, await closing.yearStatus(ctx.tenantContext!, uuid(ctx)))
  }

  async closeYear(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return ok(ctx, await closing.closeYear(ctx.tenantContext!, uuid(ctx), body))
  }

  async reopenYear(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return ok(ctx, await closing.reopenYear(ctx.tenantContext!, uuid(ctx), body))
  }
}
