import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { ContractService } from '#modules/procurement/application/contract_service'
import { CONTRACT_STATUSES } from '#modules/procurement/domain/contracts'

/** Contratos de fornecedor (9.6): âmbito por entidade verificado no serviço (`procurement.contracts.*`). */
const contracts = new ContractService()

const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum([...CONTRACT_STATUSES, 'EXPIRED']).optional(),
    supplierId: vine.string().uuid().optional(),
    renewalDue: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
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

export default class ContractsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await contracts.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async options(ctx: HttpContext) {
    return ok(ctx, await contracts.options(ctx.tenantContext!))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await contracts.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await contracts.create(ctx.tenantContext!, await body(ctx)))
  }

  async update(ctx: HttpContext) {
    return ok(ctx, await contracts.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async submit(ctx: HttpContext) {
    return ok(ctx, await contracts.submit(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async approve(ctx: HttpContext) {
    return ok(
      ctx,
      await contracts.decide(ctx.tenantContext!, param(ctx), 'approve', await vbody(ctx))
    )
  }

  async reject(ctx: HttpContext) {
    return ok(
      ctx,
      await contracts.decide(ctx.tenantContext!, param(ctx), 'reject', await vbody(ctx))
    )
  }

  async transition(ctx: HttpContext) {
    const action = ctx.params.action as string
    if (!['suspend', 'reactivate', 'terminate', 'cancel'].includes(action))
      throw ApiError.notFound()
    return ok(
      ctx,
      await contracts.transition(ctx.tenantContext!, param(ctx), action as never, await vbody(ctx))
    )
  }

  async propose(ctx: HttpContext) {
    return created(ctx, await contracts.propose(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async amendment(ctx: HttpContext) {
    const action = ctx.params.action as string
    if (!['approve', 'reject', 'cancel'].includes(action)) throw ApiError.notFound()
    return ok(
      ctx,
      await contracts.decideAmendment(
        ctx.tenantContext!,
        param(ctx),
        action as never,
        await vbody(ctx)
      )
    )
  }
}
