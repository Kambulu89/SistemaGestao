import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { sortableFields } from '#shared/db/tenant_crud'
import {
  FILTERS,
  OrganizationService,
  SPECS,
} from '#modules/organization/application/organization_service'
import type { OrgKind } from '#modules/organization/domain/organization'

/** Segmento do URL → tipo. Os campos são validados pelo domínio, que só aceita os declarados (sem mass assignment). */
const KINDS: Record<string, OrgKind> = {
  'legal-entities': 'legalEntities',
  'branches': 'branches',
  'departments': 'departments',
  'positions': 'positions',
  'cost-centers': 'costCenters',
}

const listValidator = vine.create(
  vine
    .object({
      q: vine.string().trim().maxLength(100).optional(),
      limit: vine.number().withoutDecimals().min(1).max(200).optional(),
      offset: vine.number().withoutDecimals().min(0).optional(),
      sort: vine.string().trim().maxLength(40).optional(),
      direction: vine.enum(['asc', 'desc'] as const).optional(),
    })
    .allowUnknownProperties()
)
const createValidator = vine.create(vine.object({}).allowUnknownProperties())
const updateValidator = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)

const service = new OrganizationService()

function kindOf(ctx: HttpContext): OrgKind {
  const kind = KINDS[ctx.params.kind as string]
  if (!kind) throw ApiError.notFound()
  return kind
}
const idOf = (ctx: HttpContext) => {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

export default class OrganizationController {
  async index(ctx: HttpContext) {
    const kind = kindOf(ctx)
    const query = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const equals: Record<string, unknown> = {}
    for (const key of FILTERS[kind]) {
      const value = ctx.request.qs()[key]
      if (typeof value !== 'string' || value === '') continue
      if (key.endsWith('Id') && !isUuid(value)) {
        throw ApiError.validation([
          { path: key, code: 'INVALID', message: 'Identificador inválido.' },
        ])
      }
      equals[key] = value
    }
    if (query.sort && !sortableFields(SPECS[kind]).includes(query.sort)) {
      throw ApiError.validation([
        { path: 'sort', code: 'NOT_SORTABLE', message: 'Não é possível ordenar por este campo.' },
      ])
    }
    const page = await service.list(ctx.tenantContext!, kind, {
      equals,
      q: query.q,
      limit: query.limit,
      offset: query.offset,
      sort: query.sort ? { field: query.sort, direction: query.direction ?? 'asc' } : undefined,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async dependents(ctx: HttpContext) {
    return ok(ctx, await service.dependents(ctx.tenantContext!, kindOf(ctx), idOf(ctx)))
  }

  async tree(ctx: HttpContext) {
    const legalEntityId = ctx.request.qs().legalEntityId
    if (legalEntityId !== undefined && !isUuid(legalEntityId))
      throw ApiError.validation([
        { path: 'legalEntityId', code: 'INVALID', message: 'Identificador inválido.' },
      ])
    return ok(ctx, await service.tree(ctx.tenantContext!, kindOf(ctx), legalEntityId))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await service.get(ctx.tenantContext!, kindOf(ctx), idOf(ctx)))
  }

  async store(ctx: HttpContext) {
    const kind = kindOf(ctx)
    const body = (await ctx.request.validateUsing(createValidator)) as Record<string, unknown>
    const row = await service.create(ctx.tenantContext!, kind, body)
    return created(ctx, row, `/api/v1/organization/${ctx.params.kind}/${row.id}`)
  }

  async update(ctx: HttpContext) {
    const kind = kindOf(ctx)
    const body = (await ctx.request.validateUsing(updateValidator)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return ok(ctx, await service.update(ctx.tenantContext!, kind, idOf(ctx), body))
  }
}
