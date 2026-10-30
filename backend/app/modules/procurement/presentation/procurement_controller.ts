import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { procurementServices } from '#modules/procurement/presentation/composition'
import {
  convertRequisitionValidator,
  createPurchaseValidator,
  createReceiptValidator,
  createRequisitionValidator,
  createSupplierValidator,
  listPurchasesValidator,
  listReceiptsValidator,
  listRequisitionsValidator,
  listSuppliersValidator,
  optionalReasonValidator,
  purchaseLineValidator,
  reasonValidator,
  receiptLineValidator,
  requisitionLineValidator,
  updatePurchaseValidator,
  updateReceiptValidator,
  updateRequisitionValidator,
  updateSupplierValidator,
} from '#modules/procurement/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class ProcurementController {
  // --- fornecedores --------------------------------------------------------------------------

  async listSuppliers(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listSuppliersValidator, { data: ctx.request.qs() })
    const { items, total } = await procurementServices().suppliers.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showSupplier(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().suppliers.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createSupplier(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createSupplierValidator)
    const created = await procurementServices().suppliers.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/suppliers/${created.id}`)
    return envelope(ctx, created)
  }

  async updateSupplier(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateSupplierValidator)
    return envelope(
      ctx,
      await procurementServices().suppliers.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  // --- requisições ---------------------------------------------------------------------------

  async listRequisitions(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listRequisitionsValidator, { data: ctx.request.qs() })
    const { items, total } = await procurementServices().requisitions.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showRequisition(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().requisitions.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createRequisition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createRequisitionValidator)
    const created = await procurementServices().requisitions.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/purchase-requisitions/${created.id}`)
    return envelope(ctx, created)
  }

  async updateRequisition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateRequisitionValidator)
    return envelope(
      ctx,
      await procurementServices().requisitions.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async removeRequisition(ctx: HttpContext) {
    await procurementServices().requisitions.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addRequisitionLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(requisitionLineValidator)
    const requisition = await procurementServices().requisitions.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, requisition)
  }

  async removeRequisitionLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().requisitions.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async submitRequisition(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().requisitions.submit(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async approveRequisition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(optionalReasonValidator)
    return envelope(
      ctx,
      await procurementServices().requisitions.decide(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        'APPROVED',
        b.reason
      )
    )
  }

  async rejectRequisition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    return envelope(
      ctx,
      await procurementServices().requisitions.decide(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        'REJECTED',
        b.reason
      )
    )
  }

  async convertRequisition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(convertRequisitionValidator)
    const result = await procurementServices().purchases.convert(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    if (!result.idempotent) ctx.response.status(201)
    return envelope(ctx, result)
  }

  // --- encomendas a fornecedor ---------------------------------------------------------------

  async listPurchases(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listPurchasesValidator, { data: ctx.request.qs() })
    const { items, total } = await procurementServices().purchases.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showPurchase(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().purchases.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createPurchase(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createPurchaseValidator)
    const created = await procurementServices().purchases.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/purchase-orders/${created.id}`)
    return envelope(ctx, created)
  }

  async updatePurchase(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updatePurchaseValidator)
    return envelope(
      ctx,
      await procurementServices().purchases.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async removePurchase(ctx: HttpContext) {
    await procurementServices().purchases.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addPurchaseLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(purchaseLineValidator)
    const order = await procurementServices().purchases.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, order)
  }

  async removePurchaseLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().purchases.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async confirmPurchase(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().purchases.confirm(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async cancelPurchase(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    return envelope(
      ctx,
      await procurementServices().purchases.cancel(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.reason
      )
    )
  }

  // --- recepções -----------------------------------------------------------------------------

  async listReceipts(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listReceiptsValidator, { data: ctx.request.qs() })
    const { items, total } = await procurementServices().receipts.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showReceipt(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().receipts.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createReceipt(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createReceiptValidator)
    const created = await procurementServices().receipts.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/goods-receipts/${created.id}`)
    return envelope(ctx, created)
  }

  async updateReceipt(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateReceiptValidator)
    return envelope(
      ctx,
      await procurementServices().receipts.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async removeReceipt(ctx: HttpContext) {
    await procurementServices().receipts.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addReceiptLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(receiptLineValidator)
    const receipt = await procurementServices().receipts.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, receipt)
  }

  async removeReceiptLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().receipts.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async postReceipt(ctx: HttpContext) {
    return envelope(
      ctx,
      await procurementServices().receipts.post(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async reverseReceipt(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    return envelope(
      ctx,
      await procurementServices().receipts.reverse(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.reason
      )
    )
  }
}
