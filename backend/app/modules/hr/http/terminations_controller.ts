import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { TerminationService } from '#modules/hr/application/termination_service'

/**
 * Cessação (7.11): âmbito `hr.terminations.read|manage|approve` sobre a colocação do colaborador, verificado no
 * serviço (gerar a liquidação exige também `hr.payroll.manage` na entidade legal). Só o corpo JSON é validado aqui.
 */
const terminations = new TerminationService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const onlyVersion = vine.create(vine.object(version))
const decisionBody = vine.create(
  vine.object({
    approve: vine.boolean(),
    note: vine.string().trim().maxLength(2000).nullable().optional(),
    ...version,
  })
)
const cancelBody = vine.create(
  vine.object({ reason: vine.string().trim().maxLength(2000).nullable().optional(), ...version })
)
const taskBody = vine.create(
  vine.object({
    status: vine.string(),
    notes: vine.string().trim().maxLength(2000).nullable().optional(),
    ...version,
  })
)
const listQuery = vine.create(
  vine.object({
    status: vine
      .enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SETTLED', 'CANCELLED'] as const)
      .optional(),
    employeeId: vine.string().uuid().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class TerminationsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await terminations.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await terminations.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(
      ctx,
      await terminations.create(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await terminations.update(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async addLine(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(
      ctx,
      await terminations.saveLine(ctx.tenantContext!, param(ctx), null, b, expectedVersion)
    )
  }

  async updateLine(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(
      ctx,
      await terminations.saveLine(
        ctx.tenantContext!,
        param(ctx),
        param(ctx, 'lineId'),
        b,
        expectedVersion
      )
    )
  }

  async removeLine(ctx: HttpContext) {
    return ok(
      ctx,
      await terminations.removeLine(ctx.tenantContext!, param(ctx), param(ctx, 'lineId'))
    )
  }

  async submit(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await terminations.submit(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async decide(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, decisionBody)
    return ok(ctx, await terminations.decide(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion, reason } = await body(ctx, cancelBody)
    return ok(
      ctx,
      await terminations.cancel(ctx.tenantContext!, param(ctx), reason ?? null, expectedVersion)
    )
  }

  async settlement(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await terminations.settlement(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async complete(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await terminations.complete(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async addTask(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await terminations.addTask(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async setTask(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, taskBody)
    return ok(ctx, await terminations.setTask(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }
}
