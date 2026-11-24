import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { NoteService } from '#modules/sales/application/note_service'
import { NOTE_KINDS, NOTE_STATUSES } from '#modules/sales/domain/notes'

/** Notas de crédito/débito e reembolsos (10.8): âmbito RBAC por entidade legal, verificado no serviço. */
const notes = new NoteService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    kind: vine.enum(NOTE_KINDS).optional(),
    status: vine.enum(NOTE_STATUSES).optional(),
    invoiceId: vine.string().uuid().optional(),
    customerId: vine.string().uuid().optional(),
    credit: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const searchQuery = vine.create(vine.object({ q: vine.string().trim().maxLength(100).optional() }))
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })

export default class SalesNotesController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await notes.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
  async options(ctx: HttpContext) {
    return ok(ctx, await notes.options(ctx.tenantContext!))
  }
  async searchInvoices(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchQuery, { data: ctx.request.qs() })
    return ok(ctx, await notes.searchInvoices(ctx.tenantContext!, q ?? ''))
  }
  async eligible(ctx: HttpContext) {
    return ok(ctx, await notes.eligible(ctx.tenantContext!, param(ctx, 'invoiceId')))
  }
  async show(ctx: HttpContext) {
    return ok(ctx, await notes.get(ctx.tenantContext!, param(ctx)))
  }
  async store(ctx: HttpContext) {
    return created(ctx, await notes.create(ctx.tenantContext!, await body(ctx)))
  }
  async update(ctx: HttpContext) {
    return ok(ctx, await notes.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async issue(ctx: HttpContext) {
    return ok(ctx, await notes.issue(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async discard(ctx: HttpContext) {
    return ok(ctx, await notes.discard(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async applyCredit(ctx: HttpContext) {
    return ok(ctx, await notes.applyCredit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async storeRefund(ctx: HttpContext) {
    return created(ctx, await notes.registerRefund(ctx.tenantContext!, param(ctx), await body(ctx)))
  }
  async confirmRefund(ctx: HttpContext) {
    return ok(
      ctx,
      await notes.decideRefund(ctx.tenantContext!, param(ctx), await vbody(ctx), 'confirm')
    )
  }
  async rejectRefund(ctx: HttpContext) {
    return ok(
      ctx,
      await notes.decideRefund(ctx.tenantContext!, param(ctx), await vbody(ctx), 'reject')
    )
  }
  async cancelRefund(ctx: HttpContext) {
    return ok(
      ctx,
      await notes.decideRefund(ctx.tenantContext!, param(ctx), await vbody(ctx), 'cancel')
    )
  }
}
