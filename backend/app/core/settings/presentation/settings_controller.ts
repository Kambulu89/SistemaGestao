import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { settingsServices } from '#core/settings/presentation/composition'
import {
  convertValidator,
  createSequenceValidator,
  createTaxRateValidator,
  createUnitValidator,
  effectiveQueryValidator,
  personalValueValidator,
  previewSequenceValidator,
  resetSettingValidator,
  sequenceListValidator,
  setSettingValidator,
  settingsListValidator,
  taxListValidator,
  updateSequenceValidator,
  updateTaxRateValidator,
  updateUnitValidator,
} from '#core/settings/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

function created<T extends { id: string }>(ctx: HttpContext, path: string, body: T) {
  ctx.response.status(201).header('location', `/api/v1/${path}/${body.id}`)
  return envelope(ctx, body)
}

const query = <T>(ctx: HttpContext, validator: { validate: (d: unknown) => Promise<T> }) =>
  ctx.request.validateUsing(validator as never, { data: ctx.request.qs() }) as Promise<T>

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class SettingsController {
  // --- configurações -------------------------------------------------------------------------

  async effective(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(effectiveQueryValidator, { data: ctx.request.qs() })
    return envelope(ctx, await settingsServices().resolveSettings.execute(ctx.tenantContext, q))
  }

  async list(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(settingsListValidator, { data: ctx.request.qs() })
    return envelope(ctx, await settingsServices().listSettings.execute(ctx.tenantContext, q))
  }

  async set(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(setSettingValidator)
    return envelope(
      ctx,
      await settingsServices().setSetting.execute(ctx.tenantContext, ctx.params.key, {
        scopeType: body.scopeType,
        scopeId: body.scopeId ?? null,
        moduleCode: body.moduleCode ?? null,
        value: body.value,
        expectedVersion: body.expectedVersion,
      })
    )
  }

  async reset(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(resetSettingValidator, { data: ctx.request.qs() })
    await settingsServices().resetSetting.execute(ctx.tenantContext, ctx.params.key, {
      scopeType: q.scopeType,
      scopeId: q.scopeId ?? null,
      moduleCode: q.moduleCode ?? null,
    })
    return ctx.response.noContent()
  }

  /** Preferência pessoal: só o próprio membro, no seu âmbito `MEMBERSHIP`, se a chave a admitir. */
  async setPersonal(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(personalValueValidator)
    return envelope(
      ctx,
      await settingsServices().setSetting.execute(ctx.tenantContext, ctx.params.key, {
        scopeType: 'MEMBERSHIP',
        scopeId: ctx.tenantContext.membershipId,
        moduleCode: null,
        value: body.value,
        expectedVersion: body.expectedVersion,
      })
    )
  }

  async resetPersonal(ctx: HttpContext) {
    await settingsServices().resetSetting.execute(ctx.tenantContext, ctx.params.key, {
      scopeType: 'MEMBERSHIP',
      scopeId: ctx.tenantContext.membershipId,
      moduleCode: null,
    })
    return ctx.response.noContent()
  }

  // --- impostos ------------------------------------------------------------------------------

  async listTaxRates(ctx: HttpContext) {
    const q = await query(ctx, taxListValidator)
    return envelope(ctx, await settingsServices().taxRates.list(ctx.tenantContext, q))
  }

  async createTaxRate(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createTaxRateValidator)
    const rate = await settingsServices().taxRates.create(ctx.tenantContext, {
      ...b,
      validTo: b.validTo ?? null,
      exemptionReason: b.exemptionReason ?? null,
    })
    return created(ctx, 'tax-rates', rate)
  }

  async updateTaxRate(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateTaxRateValidator)
    return envelope(
      ctx,
      await settingsServices().taxRates.update(ctx.tenantContext, idParam(ctx), b)
    )
  }

  // --- unidades ------------------------------------------------------------------------------

  async listUnits(ctx: HttpContext) {
    return envelope(ctx, await settingsServices().units.list(ctx.tenantContext))
  }

  async createUnit(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createUnitValidator)
    const unit = await settingsServices().units.create(ctx.tenantContext, {
      code: b.code,
      name: b.name,
      dimension: b.dimension,
      precision: b.precision,
      baseUnitId: b.baseUnitId ?? null,
      factor: b.conversionFactor ?? null,
    })
    return created(ctx, 'units', unit)
  }

  async updateUnit(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateUnitValidator)
    return envelope(ctx, await settingsServices().units.update(ctx.tenantContext, idParam(ctx), b))
  }

  async convert(ctx: HttpContext) {
    const q = await query(ctx, convertValidator)
    return envelope(ctx, await settingsServices().units.convert(ctx.tenantContext, q))
  }

  // --- sequências ----------------------------------------------------------------------------

  async listSequences(ctx: HttpContext) {
    const q = await query(ctx, sequenceListValidator)
    return envelope(ctx, await settingsServices().sequences.list(ctx.tenantContext, q))
  }

  async createSequence(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createSequenceValidator)
    const sequence = await settingsServices().sequences.create(ctx.tenantContext, {
      organizationId: b.organizationId,
      branchId: b.branchId ?? null,
      documentType: b.documentType,
      series: b.series,
      period: b.period ?? 'ALL',
      prefixTemplate: b.prefixTemplate,
      nextValue: b.nextValue ?? '1',
      padding: b.padding ?? 6,
    })
    return created(ctx, 'sequences', sequence)
  }

  async updateSequence(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateSequenceValidator)
    return envelope(
      ctx,
      await settingsServices().sequences.update(ctx.tenantContext, idParam(ctx), b)
    )
  }

  async previewSequence(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(previewSequenceValidator)
    return envelope(
      ctx,
      await settingsServices().sequences.preview(ctx.tenantContext, {
        organizationId: b.organizationId,
        branchId: b.branchId ?? null,
        series: b.series,
        prefixTemplate: b.prefixTemplate,
        padding: b.padding ?? 6,
        nextValue: b.nextValue ?? '1',
        date: b.date ?? undefined,
      })
    )
  }
}
