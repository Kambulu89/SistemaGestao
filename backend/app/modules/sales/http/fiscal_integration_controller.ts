import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { FiscalIntegrationService } from '#modules/sales/application/fiscal_integration_service'
import { SUBMISSION_STATUSES } from '#modules/sales/domain/fiscal_integration'

/** Integração fiscal electrónica (10.9, só simulação): âmbito de `sales.fiscal.read|manage` verificado no serviço. */
const integration = new FiscalIntegrationService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(SUBMISSION_STATUSES).optional(),
    documentType: vine.enum(['SALES_INVOICE', 'SALES_NOTE']).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })

export default class FiscalIntegrationController {
  async settings(ctx: HttpContext) {
    return ok(ctx, await integration.settings(ctx.tenantContext!))
  }
  async updateSettings(ctx: HttpContext) {
    return ok(
      ctx,
      await integration.updateSettings(
        ctx.tenantContext!,
        param(ctx, 'legalEntityId'),
        await body(ctx)
      )
    )
  }
  async contingency(ctx: HttpContext) {
    return ok(
      ctx,
      await integration.setContingency(
        ctx.tenantContext!,
        param(ctx, 'legalEntityId'),
        await body(ctx)
      )
    )
  }
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await integration.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
  async show(ctx: HttpContext) {
    return ok(ctx, await integration.get(ctx.tenantContext!, param(ctx)))
  }
  async forDocument(ctx: HttpContext) {
    return ok(
      ctx,
      await integration.forDocument(
        ctx.tenantContext!,
        String(ctx.params.type),
        param(ctx, 'documentId')
      )
    )
  }
  async processQueue(ctx: HttpContext) {
    return ok(ctx, await integration.processQueue(ctx.tenantContext!))
  }
  async processOne(ctx: HttpContext) {
    return ok(ctx, await integration.processOne(ctx.tenantContext!, param(ctx)))
  }
  async requeue(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versioned, { data: ctx.request.body() })
    return ok(ctx, await integration.requeue(ctx.tenantContext!, param(ctx), b))
  }
}
