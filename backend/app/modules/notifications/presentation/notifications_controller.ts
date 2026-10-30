import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { iamServices } from '#core/permissions/index'
import { isUuid } from '#core/tenancy/index'
import { NOTIFICATION_TYPES } from '#modules/notifications/domain/notifications'
import { notificationServices } from '#modules/notifications/presentation/composition'
import {
  listDeliveriesValidator,
  listNotificationsValidator,
  manualRequestValidator,
  updatePreferencesValidator,
} from '#modules/notifications/presentation/validators'

function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class NotificationsController {
  // --- centro (o próprio destinatário) ------------------------------------------------------------

  async list(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listNotificationsValidator, {
      data: ctx.request.qs(),
    })
    const { items, total, unread } = await notificationServices().center.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total, unread })
  }

  async markRead(ctx: HttpContext) {
    return envelope(
      ctx,
      await notificationServices().center.markRead(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async markAllRead(ctx: HttpContext) {
    return envelope(ctx, await notificationServices().center.markAllRead(ctx.tenantContext))
  }

  async open(ctx: HttpContext) {
    const allowed = async (permission: string) => {
      const decision = await iamServices().authorize.decision(ctx.tenantContext, permission)
      return decision.allowed
    }
    return envelope(
      ctx,
      await notificationServices().center.open(ctx.tenantContext, uuidParam(ctx, 'id'), allowed)
    )
  }

  // --- preferências -------------------------------------------------------------------------------

  async types(ctx: HttpContext) {
    return envelope(
      ctx,
      NOTIFICATION_TYPES.map((t) => ({
        code: t.code,
        description: t.description,
        classification: t.classification,
        channels: t.channels,
        manual: t.manual,
      }))
    )
  }

  async preferences(ctx: HttpContext) {
    return envelope(ctx, await notificationServices().preferences.list(ctx.tenantContext))
  }

  async updatePreferences(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updatePreferencesValidator)
    return envelope(
      ctx,
      await notificationServices().preferences.update(ctx.tenantContext, b.preferences)
    )
  }

  // --- administração ------------------------------------------------------------------------------

  async listDeliveries(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listDeliveriesValidator, { data: ctx.request.qs() })
    const { items, total } = await notificationServices().deliveries.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async retryDelivery(ctx: HttpContext) {
    return envelope(
      ctx,
      await notificationServices().deliveries.retry(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createRequest(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(manualRequestValidator)
    const result = await notificationServices().requests.sendManual(ctx.tenantContext, b)
    ctx.response.status(201)
    return envelope(ctx, result)
  }
}
