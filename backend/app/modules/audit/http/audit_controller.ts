import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ok } from '#shared/http/respond'
import { listAuditEvents } from '#modules/audit/application/audit_log'

const listValidator = vine.create(
  vine.object({
    action: vine
      .string()
      .trim()
      .maxLength(80)
      .regex(/^[a-z_]+(\.[a-z_]+)*(\.\*)?$/)
      .optional(),
    entityType: vine
      .string()
      .trim()
      .maxLength(60)
      .regex(/^[a-z_]+$/)
      .optional(),
    entityId: vine.string().uuid().optional(),
    actorUserId: vine.string().uuid().optional(),
    from: vine.date({ formats: ['iso8601'] }).optional(),
    to: vine.date({ formats: ['iso8601'] }).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

export default class AuditController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const page = await listAuditEvents(ctx.tenantContext!, {
      ...q,
      from: q.from?.toJSDate(),
      to: q.to?.toJSDate(),
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }
}
