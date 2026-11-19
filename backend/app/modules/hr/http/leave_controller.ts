import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  LeaveBalanceService,
  LeaveRequestService,
  LeaveSettingsService,
} from '#modules/hr/application/leave_service'
import { REQUEST_STATUSES } from '#modules/hr/domain/leave'

/**
 * Férias e ausências (7.4). Tipos e políticas: `hr.leave.settings` (rota). Pedidos, saldos e ajustes: o âmbito
 * (próprio, chefia directa, `hr.leave.*`) é verificado no serviço. Só o corpo JSON é validado.
 */
const settings = new LeaveSettingsService()
const balances = new LeaveBalanceService()
const requests = new LeaveRequestService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const onlyVersion = vine.create(vine.object(version))
const yearQuery = vine.create(
  vine.object({ year: vine.number().withoutDecimals().min(2000).max(2100).optional() })
)
const accrualBody = vine.create(
  vine.object({
    year: vine.number().withoutDecimals().min(2000).max(2100),
    employeeIds: vine.array(vine.string().uuid()).maxLength(500).optional(),
  })
)
const listQuery = vine.create(
  vine.object({
    status: vine.enum(REQUEST_STATUSES).optional(),
    employeeId: vine.string().uuid().optional(),
    from: vine
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: vine
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    mine: vine.boolean().optional(),
    toApprove: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const decisionBody = vine.create(
  vine.object({
    decision: vine.enum(['APPROVE', 'REJECT'] as const),
    comment: vine.string().trim().maxLength(1000).optional(),
    ...version,
  })
)
const cancelBody = vine.create(
  vine.object({ reason: vine.string().trim().maxLength(1000).optional(), ...version })
)

const id = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class LeaveController {
  async types(ctx: HttpContext) {
    return ok(ctx, await settings.listTypes(ctx.tenantContext!))
  }

  async createType(ctx: HttpContext) {
    return created(ctx, await settings.createType(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async updateType(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await settings.updateType(ctx.tenantContext!, id(ctx), b, expectedVersion))
  }

  async policies(ctx: HttpContext) {
    return ok(ctx, await settings.listPolicies(ctx.tenantContext!))
  }

  async policy(ctx: HttpContext) {
    return ok(ctx, await settings.getPolicy(ctx.tenantContext!, id(ctx)))
  }

  async createPolicy(ctx: HttpContext) {
    return created(ctx, await settings.createPolicy(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async updatePolicy(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await settings.updatePolicy(ctx.tenantContext!, id(ctx), b, expectedVersion))
  }

  async publishPolicy(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await settings.publishPolicy(ctx.tenantContext!, id(ctx), expectedVersion))
  }

  async accrue(ctx: HttpContext) {
    return ok(ctx, await balances.accrue(ctx.tenantContext!, await body(ctx, accrualBody)))
  }

  async summary(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(yearQuery, { data: ctx.request.qs() })
    return ok(
      ctx,
      await balances.summary(ctx.tenantContext!, id(ctx), q.year ?? new Date().getUTCFullYear())
    )
  }

  async mine(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(yearQuery, { data: ctx.request.qs() })
    return ok(ctx, await balances.mine(ctx.tenantContext!, q.year ?? new Date().getUTCFullYear()))
  }

  async adjust(ctx: HttpContext) {
    return created(
      ctx,
      await balances.adjust(ctx.tenantContext!, id(ctx), await body(ctx, anyBody))
    )
  }

  async requests(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const page = await requests.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async request(ctx: HttpContext) {
    return ok(ctx, await requests.get(ctx.tenantContext!, id(ctx)))
  }

  async preview(ctx: HttpContext) {
    return ok(ctx, await requests.preview(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async createRequest(ctx: HttpContext) {
    return created(ctx, await requests.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async decide(ctx: HttpContext) {
    const b = await body(ctx, decisionBody)
    return ok(
      ctx,
      await requests.decide(
        ctx.tenantContext!,
        id(ctx),
        b.decision === 'APPROVE',
        b.comment || null,
        b.expectedVersion
      )
    )
  }

  async cancel(ctx: HttpContext) {
    const b = await body(ctx, cancelBody)
    return ok(
      ctx,
      await requests.cancel(ctx.tenantContext!, id(ctx), b.reason || null, b.expectedVersion)
    )
  }
}
