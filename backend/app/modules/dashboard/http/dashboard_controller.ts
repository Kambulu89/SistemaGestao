import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ok } from '#shared/http/respond'
import { dashboardSummary, globalSearch } from '#modules/dashboard/application/dashboard_service'

const searchValidator = vine.create(
  vine.object({ q: vine.string().trim().minLength(2).maxLength(80) })
)

export default class DashboardController {
  async summary(ctx: HttpContext) {
    return ok(ctx, await dashboardSummary(ctx.tenantContext!))
  }

  async search(ctx: HttpContext) {
    const { q } = await ctx.request.validateUsing(searchValidator, { data: ctx.request.qs() })
    return ok(ctx, await globalSearch(ctx.tenantContext!, q))
  }
}
