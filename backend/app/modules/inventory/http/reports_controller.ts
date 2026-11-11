import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ok } from '#shared/http/respond'
import { InventoryReportService } from '#modules/inventory/application/report_service'
import { REPLENISHMENT_STATUSES } from '#modules/inventory/domain/reports'

/**
 * Alertas e relatórios do inventário (8.11): só leitura. Quantidades pelos armazéns que o membro pode consultar;
 * valores só com `inventory.valuation.read` nas entidades legais em causa — verificados no serviço.
 */
const reports = new InventoryReportService()

const warehouseId = vine.string().uuid().optional()
const days = vine.number().withoutDecimals().min(0).max(730).optional()
const range = {
  warehouseId,
  from: vine.string().trim().maxLength(10),
  to: vine.string().trim().maxLength(10),
}
const alertsQuery = vine.create(vine.object({ warehouseId, days }))
const replenishmentQuery = vine.create(
  vine.object({
    warehouseId,
    status: vine.enum(REPLENISHMENT_STATUSES).optional(),
    q: vine.string().trim().maxLength(100).optional(),
  })
)
const rangeQuery = vine.create(vine.object(range))
const movementsQuery = vine.create(
  vine.object({ ...range, productId: vine.string().uuid().optional() })
)
const valuedQuery = vine.create(
  vine.object({
    legalEntityId: vine.string().uuid(),
    date: vine.string().trim().maxLength(10).optional(),
  })
)
const DEFAULT_DAYS = 30

export default class InventoryReportsController {
  async alerts(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(alertsQuery, { data: ctx.request.qs() })
    return ok(ctx, await reports.alerts(ctx.tenantContext!, { ...q, days: q.days ?? DEFAULT_DAYS }))
  }

  async replenishment(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(replenishmentQuery, { data: ctx.request.qs() })
    const r = await reports.replenishment(ctx.tenantContext!, q)
    return ok(ctx, r.rows, { total: r.total })
  }

  async expiry(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(alertsQuery, { data: ctx.request.qs() })
    const r = await reports.expiry(ctx.tenantContext!, { ...q, days: q.days ?? DEFAULT_DAYS })
    return ok(ctx, r.rows, { total: r.total, days: r.days })
  }

  async turnover(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(rangeQuery, { data: ctx.request.qs() })
    return ok(ctx, await reports.turnover(ctx.tenantContext!, q))
  }

  async movements(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(movementsQuery, { data: ctx.request.qs() })
    return ok(ctx, await reports.movements(ctx.tenantContext!, q))
  }

  async losses(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(rangeQuery, { data: ctx.request.qs() })
    return ok(ctx, await reports.losses(ctx.tenantContext!, q))
  }

  async consumption(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(rangeQuery, { data: ctx.request.qs() })
    return ok(ctx, await reports.consumption(ctx.tenantContext!, q))
  }

  async valued(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(valuedQuery, { data: ctx.request.qs() })
    return ok(ctx, await reports.valued(ctx.tenantContext!, q))
  }
}
