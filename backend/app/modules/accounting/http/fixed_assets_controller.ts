import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  DepreciationService,
  FixedAssetService,
  FixedAssetSetupService,
} from '#modules/accounting/application/fixed_assets_service'

/** Activos fixos (6.6): classes, fichas, aquisição/transferência/abate, depreciação e mapa. */
const setup = new FixedAssetSetupService()
const assets = new FixedAssetService()
const depreciation = new DepreciationService()

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
const runValidator = vine.create(
  vine.object({ legalEntityId: vine.string().uuid(), upTo: vine.string().regex(/^\d{4}-\d{2}$/) })
)
const undoValidator = vine.create(
  vine.object({
    legalEntityId: vine.string().uuid(),
    month: vine.string().regex(/^\d{4}-\d{2}$/),
    date: vine.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: vine.string().trim().maxLength(500).optional(),
  })
)
const mapValidator = vine.create(vine.object({ fiscalYearId: vine.string().uuid() }))

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

export default class FixedAssetsController {
  async classes(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const page = await setup.listClasses(ctx.tenantContext!, {
      equals: equalsOf(ctx, ['legalEntityId', 'status']),
      q: q.q,
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async showClass(ctx: HttpContext) {
    return ok(ctx, await setup.getClass(ctx.tenantContext!, uuid(ctx)))
  }

  async createClass(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await setup.saveClass(ctx.tenantContext!, null, body))
  }

  async updateClass(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await setup.saveClass(ctx.tenantContext!, uuid(ctx), body))
  }

  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const page = await assets.list(ctx.tenantContext!, {
      equals: equalsOf(ctx, ['legalEntityId', 'classId', 'status', 'costCenterId']),
      q: q.q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await assets.get(ctx.tenantContext!, uuid(ctx)))
  }

  async store(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await assets.create(ctx.tenantContext!, body))
  }

  async update(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await assets.update(ctx.tenantContext!, uuid(ctx), body))
  }

  async destroy(ctx: HttpContext) {
    await assets.delete(ctx.tenantContext!, uuid(ctx))
    return ctx.response.noContent()
  }

  async transfer(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await assets.transfer(ctx.tenantContext!, uuid(ctx), body))
  }

  async acquire(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await assets.acquire(ctx.tenantContext!, uuid(ctx), body))
  }

  async dispose(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await assets.dispose(ctx.tenantContext!, uuid(ctx), body))
  }

  async reverseAcquisition(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await assets.reverseAcquisition(ctx.tenantContext!, uuid(ctx), body))
  }

  async reverseDisposal(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown>
    return ok(ctx, await assets.reverseDisposal(ctx.tenantContext!, uuid(ctx), body))
  }

  async preview(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(runValidator, { data: ctx.request.qs() })
    return ok(ctx, await depreciation.preview(ctx.tenantContext!, q.legalEntityId, q.upTo))
  }

  async run(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(runValidator)
    return ok(ctx, await depreciation.run(ctx.tenantContext!, q.legalEntityId, q.upTo))
  }

  async undo(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(undoValidator)
    return ok(
      ctx,
      await depreciation.undo(ctx.tenantContext!, q.legalEntityId, q.month, {
        date: q.date,
        reason: q.reason,
      })
    )
  }

  async map(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(mapValidator, { data: ctx.request.qs() })
    return ok(ctx, await depreciation.map(ctx.tenantContext!, q.fiscalYearId))
  }
}
