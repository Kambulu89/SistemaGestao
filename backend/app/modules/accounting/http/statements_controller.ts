import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  StatementNoteService,
  StatementService,
  StatementTemplateService,
} from '#modules/accounting/application/statements_service'

/** Demonstrações financeiras (6.8): modelos versionados, demonstrações e notas. */
const templates = new StatementTemplateService()
const statements = new StatementService()
const notes = new StatementNoteService()

const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const listValidator = vine.create(
  vine
    .object({
      chartId: vine.string().uuid().optional(),
      kind: vine.enum(['BALANCE_SHEET', 'INCOME_STATEMENT'] as const).optional(),
      status: vine.enum(['DRAFT', 'PUBLISHED', 'RETIRED'] as const).optional(),
    })
    .allowUnknownProperties()
)
const generateValidator = vine.create(
  vine.object({
    templateId: vine.string().uuid(),
    fiscalYearId: vine.string().uuid(),
    toPeriod: vine.number().withoutDecimals().min(0).max(30).optional(),
    compareFiscalYearId: vine.string().uuid().optional(),
  })
)
const notesValidator = vine.create(vine.object({ fiscalYearId: vine.string().uuid() }))

const uuid = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}

export default class StatementsController {
  async templates(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    return ok(ctx, await templates.list(ctx.tenantContext!, q))
  }

  async template(ctx: HttpContext) {
    return ok(ctx, await templates.get(ctx.tenantContext!, uuid(ctx)))
  }

  async createTemplate(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await templates.create(ctx.tenantContext!, body))
  }

  async updateTemplate(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return ok(ctx, await templates.update(ctx.tenantContext!, uuid(ctx), body))
  }

  async publishTemplate(ctx: HttpContext) {
    return ok(ctx, await templates.publish(ctx.tenantContext!, uuid(ctx)))
  }

  async newVersion(ctx: HttpContext) {
    return created(ctx, await templates.newVersion(ctx.tenantContext!, uuid(ctx)))
  }

  async deleteTemplate(ctx: HttpContext) {
    await templates.remove(ctx.tenantContext!, uuid(ctx))
    return ctx.response.noContent()
  }

  async generate(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(generateValidator, { data: ctx.request.qs() })
    return ok(ctx, await statements.generate(ctx.tenantContext!, q))
  }

  async notes(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(notesValidator, { data: ctx.request.qs() })
    return ok(ctx, await notes.list(ctx.tenantContext!, q.fiscalYearId))
  }

  async createNote(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await notes.save(ctx.tenantContext!, null, body))
  }

  async updateNote(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return ok(ctx, await notes.save(ctx.tenantContext!, uuid(ctx), body))
  }

  async deleteNote(ctx: HttpContext) {
    await notes.remove(ctx.tenantContext!, uuid(ctx))
    return ctx.response.noContent()
  }
}
