import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { iamServices } from '#core/permissions/index'
import { isUuid } from '#core/tenancy/index'
import { orderServices } from '#modules/orders/presentation/composition'
import {
  cancelOrderValidator,
  confirmOrderValidator,
  createShipmentLineValidator,
  createShipmentValidator,
  listShipmentsValidator,
  reverseShipmentValidator,
  updateShipmentLineValidator,
  updateShipmentValidator,
  createLineValidator,
  createOrderValidator,
  createQuoteValidator,
  listDocumentsValidator,
  updateLineValidator,
  updateOrderValidator,
  updateQuoteValidator,
} from '#modules/orders/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class OrdersController {
  // --- propostas -----------------------------------------------------------------------------

  async listQuotes(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listDocumentsValidator, { data: ctx.request.qs() })
    const { items, total } = await orderServices().quotes.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showQuote(ctx: HttpContext) {
    return envelope(ctx, await orderServices().quotes.get(ctx.tenantContext, uuidParam(ctx, 'id')))
  }

  async createQuote(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createQuoteValidator)
    const created = await orderServices().quotes.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/quotes/${created.id}`)
    return envelope(ctx, created)
  }

  async updateQuote(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateQuoteValidator)
    return envelope(
      ctx,
      await orderServices().quotes.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async addQuoteLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createLineValidator)
    const quote = await orderServices().quotes.addLine(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    ctx.response.status(201)
    return envelope(ctx, quote)
  }

  async updateQuoteLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateLineValidator)
    return envelope(
      ctx,
      await orderServices().quotes.updateLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId'),
        b
      )
    )
  }

  async removeQuoteLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await orderServices().quotes.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async sendQuote(ctx: HttpContext) {
    return envelope(ctx, await orderServices().quotes.send(ctx.tenantContext, uuidParam(ctx, 'id')))
  }

  async rejectQuote(ctx: HttpContext) {
    return envelope(
      ctx,
      await orderServices().quotes.reject(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  /** Aceitar cria a encomenda: exige também `order.manage` (a conversão é uma escrita em encomendas). */
  async acceptQuote(ctx: HttpContext) {
    await iamServices().authorize.require(ctx.tenantContext, 'order.manage')
    const result = await orderServices().quotes.accept(ctx.tenantContext, uuidParam(ctx, 'id'))
    return envelope(ctx, result)
  }

  // --- encomendas ----------------------------------------------------------------------------

  async listOrders(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listDocumentsValidator, { data: ctx.request.qs() })
    const { items, total } = await orderServices().orders.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showOrder(ctx: HttpContext) {
    return envelope(ctx, await orderServices().orders.get(ctx.tenantContext, uuidParam(ctx, 'id')))
  }

  async createOrder(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createOrderValidator)
    const created = await orderServices().orders.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/sales-orders/${created.id}`)
    return envelope(ctx, created)
  }

  async updateOrder(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateOrderValidator)
    return envelope(
      ctx,
      await orderServices().orders.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async addOrderLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createLineValidator)
    const order = await orderServices().orders.addLine(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    ctx.response.status(201)
    return envelope(ctx, order)
  }

  async updateOrderLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateLineValidator)
    return envelope(
      ctx,
      await orderServices().orders.updateLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId'),
        b
      )
    )
  }

  async removeOrderLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await orderServices().orders.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async confirmOrder(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(confirmOrderValidator)
    return envelope(
      ctx,
      await orderServices().orders.confirm(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }

  async cancelOrder(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(cancelOrderValidator)
    return envelope(
      ctx,
      await orderServices().orders.cancel(ctx.tenantContext, uuidParam(ctx, 'id'), b.reason)
    )
  }

  // --- expedições ----------------------------------------------------------------------------

  async listShipments(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listShipmentsValidator, { data: ctx.request.qs() })
    const { items, total } = await orderServices().shipments.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showShipment(ctx: HttpContext) {
    return envelope(
      ctx,
      await orderServices().shipments.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createShipment(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createShipmentValidator)
    const created = await orderServices().shipments.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/shipments/${created.id}`)
    return envelope(ctx, created)
  }

  async updateShipment(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateShipmentValidator)
    return envelope(
      ctx,
      await orderServices().shipments.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async removeShipment(ctx: HttpContext) {
    await orderServices().shipments.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addShipmentLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createShipmentLineValidator)
    const detail = await orderServices().shipments.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, detail)
  }

  async updateShipmentLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateShipmentLineValidator)
    return envelope(
      ctx,
      await orderServices().shipments.updateLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId'),
        b
      )
    )
  }

  async removeShipmentLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await orderServices().shipments.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async postShipment(ctx: HttpContext) {
    return envelope(
      ctx,
      await orderServices().shipments.post(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async reverseShipment(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reverseShipmentValidator)
    return envelope(
      ctx,
      await orderServices().shipments.reverse(ctx.tenantContext, uuidParam(ctx, 'id'), b.reason)
    )
  }
}
