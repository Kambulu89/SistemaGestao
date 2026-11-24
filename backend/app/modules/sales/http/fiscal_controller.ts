import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { FiscalService } from '#modules/sales/application/fiscal_service'

/** Motor fiscal e séries (10.5): permissões `sales.fiscal.*` da empresa verificadas no serviço. */
const fiscal = new FiscalService()

const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const page = vine.create(
  vine.object({
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const simulateBody = vine.create(
  vine.object({
    legalEntityId: vine.string().trim(),
    date: vine.string().trim().fixedLength(10),
    lines: vine
      .array(
        vine.object({
          key: vine.string().trim().maxLength(40).optional(),
          netAmount: vine.string().trim().maxLength(20),
          taxCodeIds: vine.array(vine.string().trim()).maxLength(5),
          exemptionCode: vine.string().trim().maxLength(20).nullable().optional(),
        })
      )
      .minLength(1)
      .maxLength(500),
  })
)
const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class FiscalController {
  async codes(ctx: HttpContext) {
    return ok(ctx, await fiscal.codes(ctx.tenantContext!))
  }
  async code(ctx: HttpContext) {
    return ok(ctx, await fiscal.code(ctx.tenantContext!, param(ctx)))
  }
  async createCode(ctx: HttpContext) {
    return created(ctx, await fiscal.createCode(ctx.tenantContext!, await body(ctx)))
  }
  async updateCode(ctx: HttpContext) {
    return ok(ctx, await fiscal.updateCode(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async addRate(ctx: HttpContext) {
    return created(ctx, await fiscal.addRate(ctx.tenantContext!, param(ctx), await body(ctx)))
  }
  async updateRate(ctx: HttpContext) {
    return ok(ctx, await fiscal.updateRate(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async deleteRate(ctx: HttpContext) {
    return ok(ctx, await fiscal.deleteRate(ctx.tenantContext!, param(ctx)))
  }
  async confirmRate(ctx: HttpContext) {
    return ok(ctx, await fiscal.confirmRate(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async retireRate(ctx: HttpContext) {
    return ok(ctx, await fiscal.retireRate(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async exemptions(ctx: HttpContext) {
    return ok(ctx, await fiscal.exemptions(ctx.tenantContext!))
  }
  async createExemption(ctx: HttpContext) {
    return created(ctx, await fiscal.createExemption(ctx.tenantContext!, await body(ctx)))
  }
  async updateExemption(ctx: HttpContext) {
    return ok(ctx, await fiscal.updateExemption(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async confirmExemption(ctx: HttpContext) {
    return ok(
      ctx,
      await fiscal.decideExemption(ctx.tenantContext!, param(ctx), await vbody(ctx), 'confirm')
    )
  }
  async retireExemption(ctx: HttpContext) {
    return ok(
      ctx,
      await fiscal.decideExemption(ctx.tenantContext!, param(ctx), await vbody(ctx), 'retire')
    )
  }
  async settings(ctx: HttpContext) {
    return ok(ctx, await fiscal.settings(ctx.tenantContext!))
  }
  async setRounding(ctx: HttpContext) {
    return ok(
      ctx,
      await fiscal.setRounding(ctx.tenantContext!, param(ctx, 'legalEntityId'), await body(ctx))
    )
  }
  async series(ctx: HttpContext) {
    return ok(ctx, await fiscal.series(ctx.tenantContext!))
  }
  async seriesNumbers(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(page, { data: ctx.request.qs() })
    const p = await fiscal.seriesNumbers(ctx.tenantContext!, param(ctx), {
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
  async createSeries(ctx: HttpContext) {
    return created(ctx, await fiscal.createSeries(ctx.tenantContext!, await body(ctx)))
  }
  async updateSeries(ctx: HttpContext) {
    return ok(ctx, await fiscal.updateSeries(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async activateSeries(ctx: HttpContext) {
    return ok(ctx, await fiscal.activateSeries(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async closeSeries(ctx: HttpContext) {
    return ok(ctx, await fiscal.closeSeries(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
  async simulate(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(simulateBody, { data: ctx.request.body() })
    return ok(
      ctx,
      await fiscal.simulate(ctx.tenantContext!, {
        ...input,
        lines: input.lines.map((l, i) => ({ ...l, key: l.key ?? String(i) })),
      })
    )
  }
}
