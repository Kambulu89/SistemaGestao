import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { NotificationService } from '#modules/notifications/application/notification_service'

const listValidator = vine.create(
  vine.object({
    unread: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const service = new NotificationService()

export default class NotificationsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const page = await service.list(ctx.tenantContext!, {
      unread: q.unread,
      limit: q.limit ?? 30,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total, unread: page.unread })
  }

  async read(ctx: HttpContext) {
    const id = ctx.params.id as string
    if (!isUuid(id)) throw ApiError.notFound()
    return ok(ctx, await service.markRead(ctx.tenantContext!, id))
  }

  async readAll(ctx: HttpContext) {
    return ok(ctx, await service.markAllRead(ctx.tenantContext!))
  }
}
