import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { TransferService } from '#modules/inventory/application/transfer_service'
import { TRANSFER_STATUSES } from '#modules/inventory/domain/transfers'

/**
 * Transferências (8.5): âmbito de inventory.transfers.manage / inventory.transfers.approve no armazém de cada passo
 * (origem ou destino), acesso de operação e consulta pelo acesso a um dos armazéns — verificados no serviço.
 */
const transfers = new TransferService()

const listQuery = vine.create(
  vine.object({
    status: vine.enum(TRANSFER_STATUSES).optional(),
    warehouseId: vine.string().uuid().optional(),
    q: vine.string().trim().maxLength(100).optional(),
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

export default class TransfersController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await transfers.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async destinations(ctx: HttpContext) {
    return ok(ctx, await transfers.destinations(ctx.tenantContext!))
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await transfers.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await transfers.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await transfers.update(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async submit(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(ctx, await transfers.submit(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async approve(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(
      ctx,
      await transfers.approve(ctx.tenantContext!, param(ctx), expectedVersion, 'source')
    )
  }

  async accept(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(ctx, await transfers.approve(ctx.tenantContext!, param(ctx), expectedVersion, 'dest'))
  }

  async reject(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await transfers.reject(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async pick(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await transfers.pick(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async dispatch(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await transfers.dispatch(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async receive(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await transfers.receive(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async close(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await transfers.close(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await transfers.cancel(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }
}
