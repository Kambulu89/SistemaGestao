import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { PayrollRuleService, PayrollRunService } from '#modules/hr/application/payroll_service'

/**
 * Processamento salarial (7.7). Regras: `hr.payroll.settings` (rota). Lotes: âmbito `hr.payroll.*` sobre a entidade
 * legal verificado no serviço. Só o corpo JSON é validado.
 */
const rules = new PayrollRuleService()
const runs = new PayrollRunService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const onlyVersion = vine.create(vine.object(version))
const listQuery = vine.create(
  vine.object({
    legalEntityId: vine.string().uuid().optional(),
    status: vine
      .enum(['DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'APPROVED', 'CLOSED', 'CANCELLED'] as const)
      .optional(),
    kind: vine.enum(['REGULAR', 'EXTRA', 'RETRO'] as const).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const periodsQuery = vine.create(vine.object({ legalEntityId: vine.string().uuid() }))
const decisionBody = vine.create(
  vine.object({
    decision: vine.enum(['APPROVE', 'REJECT'] as const),
    comment: vine.string().trim().maxLength(1000).optional(),
    ...version,
  })
)
const confirmBody = vine.create(
  vine.object({ note: vine.string().trim().minLength(1).maxLength(2000), ...version })
)
const exclusionBody = vine.create(
  vine.object({ employeeId: vine.string().uuid(), excluded: vine.boolean(), ...version })
)

const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class PayrollController {
  async ruleSets(ctx: HttpContext) {
    return ok(ctx, await rules.list(ctx.tenantContext!))
  }

  async ruleSet(ctx: HttpContext) {
    return ok(ctx, await rules.get(ctx.tenantContext!, param(ctx)))
  }

  async createRuleSet(ctx: HttpContext) {
    return created(ctx, await rules.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async updateRuleSet(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await rules.update(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async publishRuleSet(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await rules.publish(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async verifyRuleSet(ctx: HttpContext) {
    return ok(ctx, await rules.verify(ctx.tenantContext!, param(ctx)))
  }

  async simulateRuleSet(ctx: HttpContext) {
    return ok(ctx, await rules.simulate(ctx.tenantContext!, param(ctx), await body(ctx, anyBody)))
  }

  async confirmRuleSet(ctx: HttpContext) {
    const b = await body(ctx, confirmBody)
    return ok(ctx, await rules.confirm(ctx.tenantContext!, param(ctx), b.note, b.expectedVersion))
  }

  async deleteRuleSet(ctx: HttpContext) {
    return ok(ctx, await rules.remove(ctx.tenantContext!, param(ctx)))
  }

  async periods(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(periodsQuery, { data: ctx.request.qs() })
    return ok(ctx, await runs.periods(ctx.tenantContext!, q.legalEntityId))
  }

  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const page = await runs.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await runs.get(ctx.tenantContext!, param(ctx)))
  }

  async result(ctx: HttpContext) {
    return ok(ctx, await runs.result(ctx.tenantContext!, param(ctx), param(ctx, 'resultId')))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await runs.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async setInput(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await runs.setInput(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async setExcluded(ctx: HttpContext) {
    const b = await body(ctx, exclusionBody)
    return ok(
      ctx,
      await runs.setExcluded(
        ctx.tenantContext!,
        param(ctx),
        b.employeeId,
        b.excluded,
        b.expectedVersion
      )
    )
  }

  async calculate(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await runs.calculate(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async submit(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await runs.submit(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async decide(ctx: HttpContext) {
    const b = await body(ctx, decisionBody)
    return ok(
      ctx,
      await runs.decide(
        ctx.tenantContext!,
        param(ctx),
        b.decision === 'APPROVE',
        b.comment || null,
        b.expectedVersion
      )
    )
  }

  async close(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await runs.close(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await runs.cancel(ctx.tenantContext!, param(ctx), expectedVersion))
  }
}
