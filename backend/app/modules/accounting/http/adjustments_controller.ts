import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  AdjustmentScheduleService,
  ProvisionService,
} from '#modules/accounting/application/adjustments_service'
import { FxRevaluationService } from '#modules/accounting/application/fx_service'
import { ReconciliationService } from '#modules/accounting/application/reconciliation_service'

/** Regularizações (6.7): planos, provisões, diferenças cambiais e reconciliação de contas. */
const schedules = new AdjustmentScheduleService()
const provisions = new ProvisionService()
const fx = new FxRevaluationService()
const reconciliations = new ReconciliationService()

const listValidator = vine.create(
  vine
    .object({
      q: vine.string().trim().maxLength(100).optional(),
      limit: vine.number().withoutDecimals().min(1).max(500).optional(),
      offset: vine.number().withoutDecimals().min(0).optional(),
    })
    .allowUnknownProperties()
)
const versionValidator = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(0) }).allowUnknownProperties()
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const MONTH = /^\d{4}-\d{2}$/
const generateValidator = vine.create(
  vine.object({ legalEntityId: vine.string().uuid(), upTo: vine.string().regex(MONTH) })
)
const fxValidator = vine.create(
  vine
    .object({
      legalEntityId: vine.string().uuid(),
      date: vine.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      accountIds: vine.array(vine.string().uuid()).minLength(1).maxLength(200),
    })
    .allowUnknownProperties()
)
const accountScope = vine.create(
  vine
    .object({
      legalEntityId: vine.string().uuid(),
      accountId: vine.string().uuid(),
      thirdPartyRef: vine.string().trim().maxLength(60).optional(),
    })
    .allowUnknownProperties()
)

const uuid = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}

function equalsOf(ctx: HttpContext, keys: string[]) {
  const equals: Record<string, unknown> = {}
  for (const key of keys) {
    const v = ctx.request.qs()[key]
    if (typeof v !== 'string' || v === '') continue
    if (key.endsWith('Id') && !isUuid(v))
      throw ApiError.validation([
        { path: key, code: 'INVALID', message: 'Identificador inválido.' },
      ])
    equals[key] = v
  }
  return equals
}

/** `accountIds` chega como lista (repetido ou "a,b") na query. */
const idsOf = (raw: unknown) =>
  (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []).map(String)

export default class AdjustmentsController {
  async schedules(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const page = await schedules.list(ctx.tenantContext!, {
      equals: equalsOf(ctx, ['legalEntityId', 'kind', 'status']),
      q: q.q,
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async schedule(ctx: HttpContext) {
    return ok(ctx, await schedules.get(ctx.tenantContext!, uuid(ctx)))
  }

  async createSchedule(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await schedules.save(ctx.tenantContext!, null, body))
  }

  async updateSchedule(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await schedules.save(ctx.tenantContext!, uuid(ctx), body))
  }

  async previewSchedules(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(generateValidator, { data: ctx.request.qs() })
    return ok(ctx, await schedules.preview(ctx.tenantContext!, q.legalEntityId, q.upTo))
  }

  async generateSchedules(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(generateValidator)
    return ok(ctx, await schedules.generate(ctx.tenantContext!, q.legalEntityId, q.upTo))
  }

  async provisions(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const page = await provisions.list(ctx.tenantContext!, {
      equals: equalsOf(ctx, ['legalEntityId', 'status']),
      q: q.q,
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async provision(ctx: HttpContext) {
    return ok(ctx, await provisions.get(ctx.tenantContext!, uuid(ctx)))
  }

  async createProvision(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await provisions.save(ctx.tenantContext!, null, body))
  }

  async updateProvision(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await provisions.save(ctx.tenantContext!, uuid(ctx), body))
  }

  async moveProvision(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await provisions.move(ctx.tenantContext!, uuid(ctx), body))
  }

  async revaluations(ctx: HttpContext) {
    const le = equalsOf(ctx, ['legalEntityId']).legalEntityId as string | undefined
    return ok(ctx, await fx.list(ctx.tenantContext!, le))
  }

  async previewRevaluation(ctx: HttpContext) {
    const qs = ctx.request.qs()
    const q = await ctx.request.validateUsing(fxValidator, {
      data: { ...qs, accountIds: idsOf(qs.accountIds) },
    })
    return ok(ctx, await fx.preview(ctx.tenantContext!, q))
  }

  async revalue(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(fxValidator)) as Record<string, unknown>
    return created(ctx, await fx.run(ctx.tenantContext!, body as never))
  }

  async openItems(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(accountScope, { data: ctx.request.qs() })
    return ok(ctx, await reconciliations.openItems(ctx.tenantContext!, q))
  }

  async reconciliations(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(accountScope, { data: ctx.request.qs() })
    return ok(ctx, await reconciliations.list(ctx.tenantContext!, q))
  }

  async reconcile(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await reconciliations.reconcile(ctx.tenantContext!, body))
  }

  async undoReconciliation(ctx: HttpContext) {
    await reconciliations.undo(ctx.tenantContext!, uuid(ctx))
    return ctx.response.noContent()
  }
}
