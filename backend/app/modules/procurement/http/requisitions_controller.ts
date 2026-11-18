import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { RequisitionService } from '#modules/procurement/application/requisition_service'
import { ApprovalLevelService } from '#modules/procurement/application/approval_level_service'
import { PRIORITIES, REQUISITION_STATUSES } from '#modules/procurement/domain/requisitions'

/**
 * Requisições de compra (9.2): âmbito verificado no serviço (`procurement.requisitions.request|approve|process`).
 * Etapas de aprovação: leitura com permissões de compras (serviço), alteração com `procurement.settings` (rota).
 */
const requisitions = new RequisitionService()
const levels = new ApprovalLevelService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(REQUISITION_STATUSES).optional(),
    priority: vine.enum(PRIORITIES).optional(),
    departmentId: vine.string().uuid().optional(),
    mine: vine.boolean().optional(),
    awaitingMe: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const demandQuery = vine.create(
  vine.object({
    legalEntityId: vine.string().uuid().optional(),
    q: vine.string().trim().maxLength(100).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext) => ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class RequisitionsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await requisitions.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async options(ctx: HttpContext) {
    return ok(ctx, await requisitions.options(ctx.tenantContext!))
  }

  async demand(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(demandQuery, { data: ctx.request.qs() })
    return ok(ctx, await requisitions.demand(ctx.tenantContext!, q))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await requisitions.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await requisitions.create(ctx.tenantContext!, await body(ctx)))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await requisitions.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async submit(ctx: HttpContext) {
    return ok(ctx, await requisitions.submit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async approve(ctx: HttpContext) {
    return ok(
      ctx,
      await requisitions.decide(ctx.tenantContext!, param(ctx), 'approve', await vbody(ctx))
    )
  }

  async reject(ctx: HttpContext) {
    return ok(
      ctx,
      await requisitions.decide(ctx.tenantContext!, param(ctx), 'reject', await vbody(ctx))
    )
  }

  async cancel(ctx: HttpContext) {
    return ok(ctx, await requisitions.cancel(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async close(ctx: HttpContext) {
    return ok(ctx, await requisitions.close(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async copy(ctx: HttpContext) {
    return created(ctx, await requisitions.copy(ctx.tenantContext!, param(ctx)))
  }

  async levels(ctx: HttpContext) {
    return ok(ctx, await levels.list(ctx.tenantContext!))
  }

  async createLevel(ctx: HttpContext) {
    return created(ctx, await levels.save(ctx.tenantContext!, null, await body(ctx)))
  }

  async updateLevel(ctx: HttpContext) {
    return ok(ctx, await levels.save(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }
}
