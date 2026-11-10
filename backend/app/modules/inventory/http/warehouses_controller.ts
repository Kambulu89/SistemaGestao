import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { WarehouseService } from '#modules/inventory/application/warehouse_service'

/**
 * Armazéns (8.2): âmbito RBAC de `inventory.read` / `inventory.warehouses.manage` sobre a entidade legal ou filial do
 * armazém e lista de acesso dos armazéns restritos, verificados no serviço. Só o corpo JSON é validado aqui.
 */
const warehouses = new WarehouseService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    legalEntityId: vine.string().uuid().optional(),
    status: vine.enum(['ACTIVE', 'INACTIVE'] as const).optional(),
    warehouseType: vine.string().trim().maxLength(20).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)

const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class WarehousesController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await warehouses.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total, canCreate: p.canCreate ?? false })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await warehouses.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await warehouses.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await warehouses.update(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async addLocations(ctx: HttpContext) {
    return created(
      ctx,
      await warehouses.addLocations(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async updateLocation(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(
      ctx,
      await warehouses.updateLocation(ctx.tenantContext!, param(ctx), b, expectedVersion)
    )
  }

  async setAccess(ctx: HttpContext) {
    return ok(
      ctx,
      await warehouses.setAccess(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async candidates(ctx: HttpContext) {
    return ok(ctx, await warehouses.candidates(ctx.tenantContext!))
  }
}
