import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ok } from '#shared/http/respond'
import { PortalService } from '#modules/hr/application/portal_service'
import { HrReportsService } from '#modules/hr/application/hr_reports_service'

/**
 * Portais e relatórios (7.12). O meu espaço e a minha equipa: só a ficha ligada à conta do actor e a sua equipa
 * (verificado no serviço). Relatórios: `hr.reports.read` (efectivos, rotatividade, férias) e `hr.payroll.read` por
 * entidade legal (folha), verificados no serviço.
 */
const portal = new PortalService()
const reports = new HrReportsService()

const contactsBody = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(0) }).allowUnknownProperties()
)

export default class PortalController {
  async me(ctx: HttpContext) {
    return ok(ctx, await portal.me(ctx.tenantContext!))
  }

  async updateMe(ctx: HttpContext) {
    const { expectedVersion, ...b } = (await ctx.request.validateUsing(contactsBody, {
      data: ctx.request.body(),
    })) as any
    return ok(ctx, await portal.updateContacts(ctx.tenantContext!, b, expectedVersion))
  }

  async team(ctx: HttpContext) {
    return ok(ctx, await portal.team(ctx.tenantContext!))
  }

  async headcount(ctx: HttpContext) {
    return ok(ctx, await reports.headcount(ctx.tenantContext!, ctx.request.qs()))
  }

  async turnover(ctx: HttpContext) {
    return ok(ctx, await reports.turnover(ctx.tenantContext!, ctx.request.qs()))
  }

  async leave(ctx: HttpContext) {
    return ok(ctx, await reports.leave(ctx.tenantContext!, ctx.request.qs()))
  }

  async payroll(ctx: HttpContext) {
    return ok(ctx, await reports.payroll(ctx.tenantContext!, ctx.request.qs()))
  }
}
