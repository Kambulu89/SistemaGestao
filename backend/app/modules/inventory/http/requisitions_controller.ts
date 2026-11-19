import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  activeReservations,
  RequisitionService,
} from '#modules/inventory/application/requisition_service'
import { REQUISITION_STATUSES } from '#modules/inventory/domain/requisitions'

/**
 * Requisições internas e reservas (8.6): âmbito de inventory.requisitions.request / .approve sobre o departamento
 * (ou só as próprias), inventory.requisitions.fulfil sobre o armazém com acesso de operação; reservas pelo acesso aos
 * armazéns — verificados no serviço.
 */
const requisitions = new RequisitionService()

const listQuery = vine.create(
  vine.object({
    status: vine.enum(REQUISITION_STATUSES).optional(),
    warehouseId: vine.string().uuid().optional(),
    departmentId: vine.string().uuid().optional(),
    q: vine.string().trim().maxLength(100).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const reservationsQuery = vine.create(
  vine.object({
    warehouseId: vine.string().uuid().optional(),
    productId: vine.string().uuid().optional(),
    sourceType: vine.string().trim().maxLength(30).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(0) }).allowUnknownProperties()
)
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class RequisitionsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await requisitions.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async options(ctx: HttpContext) {
    return ok(ctx, await requisitions.options(ctx.tenantContext!))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await requisitions.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await requisitions.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await requisitions.update(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async submit(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(ctx, await requisitions.submit(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async approve(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(ctx, await requisitions.approve(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async reject(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await requisitions.reject(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async pick(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await requisitions.pick(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async issue(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await requisitions.issue(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async release(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await requisitions.release(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await requisitions.cancel(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async reservations(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(reservationsQuery, { data: ctx.request.qs() })
    const p = await activeReservations(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }
}
