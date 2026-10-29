import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { inventoryServices } from '#modules/inventory/presentation/composition'
import {
  countExtraLineValidator,
  countLinesValidator,
  createCountValidator,
  createReturnValidator,
  createTransferValidator,
  listCountsValidator,
  listReturnsValidator,
  listTransfersValidator,
  reasonValidator,
  receiveTransferValidator,
  returnLineValidator,
  returnSourceValidator,
  transferLineValidator,
  updateTransferValidator,
} from '#modules/inventory/presentation/logistics_validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class LogisticsController {
  // --- transferências ------------------------------------------------------------------------

  async listTransfers(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listTransfersValidator, { data: ctx.request.qs() })
    const { items, total } = await inventoryServices().transfers.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showTransfer(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().transfers.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createTransfer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createTransferValidator)
    const created = await inventoryServices().transfers.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/stock-transfers/${created.id}`)
    return envelope(ctx, created)
  }

  async updateTransfer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateTransferValidator)
    return envelope(
      ctx,
      await inventoryServices().transfers.updateNotes(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async removeTransfer(ctx: HttpContext) {
    await inventoryServices().transfers.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addTransferLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(transferLineValidator)
    const detail = await inventoryServices().transfers.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, detail)
  }

  async removeTransferLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().transfers.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async dispatchTransfer(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().transfers.dispatch(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async receiveTransfer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(receiveTransferValidator)
    const key = ctx.request.header('idempotency-key')?.trim() || null
    if (key !== null && (key.length > 100 || !/^[\x21-\x7e]+$/.test(key))) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
        {
          path: 'Idempotency-Key',
          code: 'INVALID_KEY',
          message: 'Chave de idempotência inválida.',
        },
      ])
    }
    return envelope(
      ctx,
      await inventoryServices().transfers.receive(ctx.tenantContext, uuidParam(ctx, 'id'), b, key)
    )
  }

  async cancelTransfer(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    return envelope(
      ctx,
      await inventoryServices().transfers.cancel(ctx.tenantContext, uuidParam(ctx, 'id'), b.reason)
    )
  }

  // --- contagens -----------------------------------------------------------------------------

  async listCounts(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listCountsValidator, { data: ctx.request.qs() })
    const { items, total } = await inventoryServices().counts.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showCount(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().counts.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createCount(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createCountValidator)
    const created = await inventoryServices().counts.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/stock-counts/${created.id}`)
    return envelope(ctx, created)
  }

  async removeCount(ctx: HttpContext) {
    await inventoryServices().counts.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async openCount(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().counts.open(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async countLines(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(countLinesValidator)
    return envelope(
      ctx,
      await inventoryServices().counts.count(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async addCountLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(countExtraLineValidator)
    const detail = await inventoryServices().counts.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, detail)
  }

  async reviewCount(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().counts.review(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async reopenCount(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().counts.reopen(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async postCount(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().counts.post(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async cancelCount(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(reasonValidator)
    return envelope(
      ctx,
      await inventoryServices().counts.cancel(ctx.tenantContext, uuidParam(ctx, 'id'), b.reason)
    )
  }

  // --- devoluções ----------------------------------------------------------------------------

  async listReturns(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listReturnsValidator, { data: ctx.request.qs() })
    const { items, total } = await inventoryServices().returns.list(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async returnSourceLines(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(returnSourceValidator, { data: ctx.request.qs() })
    return envelope(
      ctx,
      await inventoryServices().returns.sourceLines(
        ctx.tenantContext,
        q.direction,
        q.sourceDocumentId
      )
    )
  }

  async showReturn(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().returns.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createReturn(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createReturnValidator)
    const created = await inventoryServices().returns.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/goods-returns/${created.id}`)
    return envelope(ctx, created)
  }

  async removeReturn(ctx: HttpContext) {
    await inventoryServices().returns.remove(ctx.tenantContext, uuidParam(ctx, 'id'))
    return ctx.response.noContent()
  }

  async addReturnLine(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(returnLineValidator)
    const detail = await inventoryServices().returns.addLine(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, detail)
  }

  async removeReturnLine(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().returns.removeLine(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        uuidParam(ctx, 'lineId')
      )
    )
  }

  async approveReturn(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().returns.approve(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async postReturn(ctx: HttpContext) {
    return envelope(
      ctx,
      await inventoryServices().returns.post(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }
}
