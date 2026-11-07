import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { CompanyService } from '#modules/settings/application/company_service'
import {
  ReferenceService,
  type SettingsKind,
} from '#modules/settings/application/reference_service'

const company = new CompanyService()
const reference = new ReferenceService()

/** Segmento do URL → tipo (e os filtros de igualdade aceites). */
const KINDS: Record<string, { kind: SettingsKind; filters: string[] }> = {
  'exchange-rates': { kind: 'exchangeRates', filters: ['fromCurrency', 'toCurrency'] },
  'document-series': {
    kind: 'documentSeries',
    filters: ['legalEntityId', 'documentType', 'status'],
  },
  'calendars': { kind: 'calendars', filters: ['status', 'countryCode', 'legalEntityId'] },
  'bank-accounts': { kind: 'bankAccounts', filters: ['legalEntityId', 'currency', 'status'] },
}

const listValidator = vine.create(
  vine
    .object({
      q: vine.string().trim().maxLength(100).optional(),
      limit: vine.number().withoutDecimals().min(1).max(200).optional(),
      offset: vine.number().withoutDecimals().min(0).optional(),
    })
    .allowUnknownProperties()
)
const versionValidator = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(0) }).allowUnknownProperties()
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const rateLookup = vine.create(
  vine.object({
    from: vine
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/),
    to: vine
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/),
    date: vine
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/),
  })
)
const range = vine.create(
  vine.object({
    from: vine
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/),
    to: vine
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/),
  })
)
const holidayValidator = vine.create(
  vine.object({
    date: vine.string().trim(),
    name: vine.string().trim().maxLength(160),
    kind: vine.enum(['NATIONAL', 'REGIONAL', 'COMPANY'] as const).optional(),
  })
)

const uuid = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}

/** O tipo vem da própria rota (cada rota tem a sua permissão), não de um parâmetro livre. */
const kindOf = (ctx: HttpContext) => {
  const segment = ctx.route?.pattern.split('/')[3] ?? ''
  const k = KINDS[segment]
  if (!k) throw ApiError.notFound()
  return k
}

export default class SettingsController {
  // ---- perfil e configurações
  async profile(ctx: HttpContext) {
    return ok(ctx, await company.profile(ctx.tenantContext!))
  }

  async updateProfile(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return ok(ctx, await company.updateProfile(ctx.tenantContext!, body))
  }

  async settings(ctx: HttpContext) {
    return ok(ctx, await company.settings(ctx.tenantContext!))
  }

  async updateSettings(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return ok(ctx, await company.updateSettings(ctx.tenantContext!, body))
  }

  // ---- dados de referência (câmbios, séries, calendários, contas bancárias)
  async index(ctx: HttpContext) {
    const { kind, filters } = kindOf(ctx)
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const equals: Record<string, unknown> = {}
    for (const key of filters) {
      const v = ctx.request.qs()[key]
      if (typeof v !== 'string' || v === '') continue
      if (key.endsWith('Id') && !isUuid(v))
        throw ApiError.validation([
          { path: key, code: 'INVALID', message: 'Identificador inválido.' },
        ])
      equals[key] = v
    }
    const page = await reference.list(ctx.tenantContext!, kind, {
      equals,
      q: q.q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await reference.get(ctx.tenantContext!, kindOf(ctx).kind, uuid(ctx)))
  }

  async store(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await reference.create(ctx.tenantContext!, kindOf(ctx).kind, body))
  }

  async update(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return ok(ctx, await reference.update(ctx.tenantContext!, kindOf(ctx).kind, uuid(ctx), body))
  }

  async lookupRate(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(rateLookup, { data: ctx.request.qs() })
    return ok(ctx, await reference.lookupRate(ctx.tenantContext!, q.from, q.to, q.date))
  }

  async previewSeries(ctx: HttpContext) {
    return ok(ctx, await reference.preview(ctx.tenantContext!, uuid(ctx)))
  }

  async addHoliday(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(holidayValidator)
    return created(ctx, await reference.addHoliday(ctx.tenantContext!, uuid(ctx), body))
  }

  async removeHoliday(ctx: HttpContext) {
    return ok(
      ctx,
      await reference.removeHoliday(ctx.tenantContext!, uuid(ctx), uuid(ctx, 'holidayId'))
    )
  }

  async workingDays(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(range, { data: ctx.request.qs() })
    return ok(ctx, await reference.workingDays(ctx.tenantContext!, uuid(ctx), q.from, q.to))
  }
}
