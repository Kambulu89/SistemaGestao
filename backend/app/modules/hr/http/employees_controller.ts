import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { EMPLOYEE_SORT_FIELDS, EmployeeService } from '#modules/hr/application/employee_service'

/**
 * Colaboradores (7.1). O âmbito (empresa, entidade, filial, departamento ou o próprio) e a visibilidade dos dados
 * pessoais são decididos no serviço a partir das permissões `hr.read`, `hr.manage` e `hr.sensitive`.
 */
const employees = new EmployeeService()

const listValidator = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(['ACTIVE', 'SUSPENDED', 'TERMINATED'] as const).optional(),
    legalEntityId: vine.string().uuid().optional(),
    branchId: vine.string().uuid().optional(),
    departmentId: vine.string().uuid().optional(),
    positionId: vine.string().uuid().optional(),
    managerId: vine.string().uuid().optional(),
    sort: vine.enum(EMPLOYEE_SORT_FIELDS).optional(),
    direction: vine.enum(['asc', 'desc'] as const).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const updateValidator = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(0) }).allowUnknownProperties()
)
const statusValidator = vine.create(
  vine.object({
    status: vine.enum(['ACTIVE', 'SUSPENDED'] as const),
    reason: vine.string().trim().maxLength(500).optional(),
    expectedVersion: vine.number().withoutDecimals().min(0),
  })
)

const uuid = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}

export default class EmployeesController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listValidator, { data: ctx.request.qs() })
    const page = await employees.list(ctx.tenantContext!, {
      ...q,
      sort: q.sort ? { field: q.sort, direction: q.direction ?? 'asc' } : undefined,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await employees.get(ctx.tenantContext!, uuid(ctx)))
  }

  async store(ctx: HttpContext) {
    const body = (await ctx.request.validateUsing(anyBody)) as Record<string, unknown>
    return created(ctx, await employees.create(ctx.tenantContext!, body))
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...body } = await ctx.request.validateUsing(updateValidator)
    return ok(
      ctx,
      await employees.update(
        ctx.tenantContext!,
        uuid(ctx),
        body as Record<string, unknown>,
        expectedVersion
      )
    )
  }

  async setStatus(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(statusValidator)
    return ok(
      ctx,
      await employees.setStatus(
        ctx.tenantContext!,
        uuid(ctx),
        body.status,
        body.reason ?? null,
        body.expectedVersion
      )
    )
  }
}
