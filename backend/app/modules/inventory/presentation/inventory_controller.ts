import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { inventoryServices } from '#modules/inventory/presentation/composition'
import {
  adjustmentValidator,
  createLocationValidator,
  createLotValidator,
  createReservationValidator,
  createWarehouseValidator,
  listBalancesValidator,
  listLotsValidator,
  listMovementsValidator,
  listReservationsValidator,
  listWarehousesValidator,
  releaseReservationValidator,
  reverseValidator,
  updateLocationValidator,
  updateWarehouseValidator,
} from '#modules/inventory/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

const present = <T extends { quantityDelta: string }>(r: { movement: T; idempotent: boolean }) => ({
  ...r.movement,
  idempotent: r.idempotent,
})

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class InventoryController {
  // --- armazéns e locais ---------------------------------------------------------------------

  async listWarehouses(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listWarehousesValidator, { data: ctx.request.qs() })
    return envelope(ctx, await inventoryServices().warehouses.list(ctx.tenantContext, q))
  }

  async showWarehouse(ctx: HttpContext) {
    return envelope(ctx, await inventoryServices().warehouses.get(ctx.tenantContext, idParam(ctx)))
  }

  async createWarehouse(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createWarehouseValidator)
    const created = await inventoryServices().warehouses.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/warehouses/${created.id}`)
    return envelope(ctx, created)
  }

  async updateWarehouse(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateWarehouseValidator)
    return envelope(
      ctx,
      await inventoryServices().warehouses.update(ctx.tenantContext, idParam(ctx), b)
    )
  }

  async createLocation(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createLocationValidator)
    const created = await inventoryServices().warehouses.createLocation(
      ctx.tenantContext,
      idParam(ctx),
      b
    )
    ctx.response.status(201).header('location', `/api/v1/stock-locations/${created.id}`)
    return envelope(ctx, created)
  }

  async updateLocation(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateLocationValidator)
    return envelope(
      ctx,
      await inventoryServices().warehouses.updateLocation(ctx.tenantContext, idParam(ctx), b)
    )
  }

  // --- lotes ---------------------------------------------------------------------------------

  async listLots(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listLotsValidator, { data: ctx.request.qs() })
    return envelope(ctx, await inventoryServices().warehouses.listLots(ctx.tenantContext, q))
  }

  async createLot(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createLotValidator)
    const created = await inventoryServices().warehouses.createLot(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/lots/${created.id}`)
    return envelope(ctx, created)
  }

  // --- saldos e movimentos -------------------------------------------------------------------

  async listBalances(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listBalancesValidator, { data: ctx.request.qs() })
    const { items, total } = await inventoryServices().stock.balances(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async listMovements(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listMovementsValidator, { data: ctx.request.qs() })
    const { items, total } = await inventoryServices().stock.movements(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async adjust(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(adjustmentValidator)
    const result = await inventoryServices().stock.adjust(ctx.tenantContext, b)
    if (!result.idempotent) {
      ctx.response.status(201).header('location', `/api/v1/stock-movements/${result.movement.id}`)
    }
    return envelope(ctx, present(result))
  }

  async reverse(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reverseValidator)
    const result = await inventoryServices().stock.reverse(
      ctx.tenantContext,
      idParam(ctx),
      b.reason
    )
    if (!result.idempotent) ctx.response.status(201)
    return envelope(ctx, present(result))
  }

  // --- reservas ------------------------------------------------------------------------------

  async listReservations(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listReservationsValidator, { data: ctx.request.qs() })
    const { items, total } = await inventoryServices().stock.listReservations(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async createReservation(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createReservationValidator)
    const result = await inventoryServices().stock.reserve(ctx.tenantContext, {
      variantId: b.variantId,
      locationId: b.locationId,
      lotId: b.lotId ?? null,
      quantity: b.quantity,
      source: { type: b.sourceType, id: b.sourceId, lineId: b.sourceLineId ?? null },
      expiresAt: b.expiresAt ?? null,
    })
    if (!result.idempotent) {
      ctx.response
        .status(201)
        .header('location', `/api/v1/stock-reservations/${result.reservation.id}`)
    }
    return envelope(ctx, { ...result.reservation, idempotent: result.idempotent })
  }

  async releaseReservation(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(releaseReservationValidator)
    const result = await inventoryServices().stock.release(
      ctx.tenantContext,
      idParam(ctx),
      b.quantity
    )
    return envelope(ctx, { ...result.reservation, idempotent: result.idempotent })
  }

  async expireReservations(ctx: HttpContext) {
    const expired = await inventoryServices().stock.expireDue(ctx.tenantContext)
    return envelope(ctx, { expired })
  }
}
