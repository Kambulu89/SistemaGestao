import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  AccountingSetupService,
  type SetupKind,
} from '#modules/accounting/application/setup_service'
import { JournalEntryService } from '#modules/accounting/application/entries_service'

const setup = new AccountingSetupService()
const entries = new JournalEntryService()

/** Segmento do URL → tipo e filtros de igualdade aceites (o tipo vem da rota, nunca de um parâmetro livre). */
const KINDS: Record<string, { kind: SetupKind; filters: string[] }> = {
  'charts': { kind: 'charts', filters: ['legalEntityId', 'status'] },
  'accounts': {
    kind: 'accounts',
    filters: ['chartId', 'parentId', 'level', 'nature', 'postable', 'status'],
  },
  'fiscal-years': { kind: 'fiscalYears', filters: ['legalEntityId', 'status'] },
  'journals': { kind: 'journals', filters: ['legalEntityId', 'type', 'status'] },
}

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
const reasonValidator = vine.create(
  vine.object({
    expectedVersion: vine.number().withoutDecimals().min(0),
    reason: vine.string().trim().maxLength(500),
  })
)
const periodValidator = vine.create(
  vine.object({ reason: vine.string().trim().maxLength(500).optional() })
)
const reverseValidator = vine.create(
  vine.object({
    date: vine
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/),
    description: vine.string().trim().maxLength(500).optional(),
  })
)

const uuid = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const kindOf = (ctx: HttpContext) => {
  const k = KINDS[ctx.route?.pattern.split('/')[4] ?? '']
  if (!k) throw ApiError.notFound()
  return k
}
const filterValue = (key: string, v: unknown) => {
  if (typeof v !== 'string' || v === '') return undefined
  if (key.endsWith('Id') && !isUuid(v))
    throw ApiError.validation([{ path: key, code: 'INVALID', message: 'Identificador inválido.' }])
  if (key === 'postable') return v === 'true'
  return v
}

export default class AccountingController {
  // ---- configuração: planos, contas, exercícios, diários
  async index(ctx: HttpContext) {
    const { kind, filters } = kindOf(ctx)
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const equals: Record<string, unknown> = {}
    for (const key of filters) {
      const v = filterValue(key, ctx.request.qs()[key])
      if (v !== undefined) equals[key] = v
    }
    if (kind === 'accounts' && ctx.request.qs().parentId === 'root') equals.parentId = null
    const page = await setup.list(ctx.tenantContext!, kind, {
      equals,
      q: q.q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await setup.get(ctx.tenantContext!, kindOf(ctx).kind, uuid(ctx)))
  }

  async store(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await setup.create(ctx.tenantContext!, kindOf(ctx).kind, body))
  }

  async update(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return ok(ctx, await setup.update(ctx.tenantContext!, kindOf(ctx).kind, uuid(ctx), body))
  }

  async closePeriod(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(periodValidator)
    return ok(
      ctx,
      await setup.setPeriodStatus(ctx.tenantContext!, uuid(ctx), 'CLOSED', body.reason ?? null)
    )
  }

  async reopenPeriod(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(periodValidator)
    return ok(
      ctx,
      await setup.setPeriodStatus(ctx.tenantContext!, uuid(ctx), 'OPEN', body.reason ?? null)
    )
  }

  // ---- lançamentos
  async entries(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const qs = ctx.request.qs()
    const page = await entries.list(ctx.tenantContext!, {
      legalEntityId: filterValue('legalEntityId', qs.legalEntityId) as string | undefined,
      journalId: filterValue('journalId', qs.journalId) as string | undefined,
      periodId: filterValue('periodId', qs.periodId) as string | undefined,
      fiscalYearId: filterValue('fiscalYearId', qs.fiscalYearId) as string | undefined,
      status: filterValue('status', qs.status) as string | undefined,
      q: q.q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async entry(ctx: HttpContext) {
    return ok(ctx, await entries.get(ctx.tenantContext!, uuid(ctx)))
  }

  async createEntry(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    const result = await entries.create(ctx.tenantContext!, body)
    return result.created
      ? created(ctx, result.entry)
      : ok(ctx, result.entry, { idempotentReplay: true })
  }

  async updateEntry(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(versionValidator)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return ok(ctx, await entries.update(ctx.tenantContext!, uuid(ctx), body))
  }

  async deleteEntry(ctx: HttpContext) {
    await entries.remove(ctx.tenantContext!, uuid(ctx))
    return ctx.response.noContent()
  }

  async submit(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(versionValidator)
    return ok(ctx, await entries.submit(ctx.tenantContext!, uuid(ctx), expectedVersion))
  }

  async approve(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(versionValidator)
    return ok(ctx, await entries.approve(ctx.tenantContext!, uuid(ctx), expectedVersion))
  }

  async reject(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(reasonValidator)
    return ok(
      ctx,
      await entries.reject(ctx.tenantContext!, uuid(ctx), body.expectedVersion, body.reason)
    )
  }

  async post(ctx: HttpContext) {
    const { expectedVersion } = await ctx.request.validateUsing(versionValidator)
    return ok(ctx, await entries.post(ctx.tenantContext!, uuid(ctx), expectedVersion))
  }

  async reverse(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(reverseValidator)
    return created(ctx, await entries.reverse(ctx.tenantContext!, uuid(ctx), body))
  }
}
