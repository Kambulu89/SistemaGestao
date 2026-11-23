import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { CreditNoteService } from '#modules/procurement/application/credit_note_service'
import { CREDIT_NOTE_STATUSES } from '#modules/procurement/domain/returns'

/** Notas de crédito de fornecedor (9.9): âmbito por entidade verificado no serviço (`procurement.invoices.*`). */
const notes = new CreditNoteService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(CREDIT_NOTE_STATUSES).optional(),
    invoiceId: vine.string().uuid().optional(),
    returnId: vine.string().uuid().optional(),
    supplierId: vine.string().uuid().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const invoiceQuery = vine.create(vine.object({ exceptNoteId: vine.string().uuid().optional() }))
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class CreditNotesController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await notes.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async invoice(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(invoiceQuery, { data: ctx.request.qs() })
    return ok(
      ctx,
      await notes.creditableInvoice(ctx.tenantContext!, param(ctx), q.exceptNoteId ?? null)
    )
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await notes.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(ctx, await notes.create(ctx.tenantContext!, b))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await notes.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async validate(ctx: HttpContext) {
    return ok(ctx, await notes.validate(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async cancel(ctx: HttpContext) {
    return ok(ctx, await notes.cancel(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
