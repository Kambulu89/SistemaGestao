import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { organizationServices } from '#core/organization/presentation/composition'
import {
  createPositionValidator,
  listPositionsValidator,
  updatePositionValidator,
} from '#core/organization/presentation/validators'

function idParam(ctx: HttpContext): string {
  const id = ctx.params.id as string
  if (!isUuid(id)) throw ApiError.notFound('Cargo não encontrado.')
  return id
}

/** Cargos e funções: transporte apenas (valida, chama o caso de uso, formata). */
export default class PositionsController {
  async list(ctx: HttpContext) {
    const filter = await ctx.request.validateUsing(listPositionsValidator, {
      data: ctx.request.qs(),
    })
    return envelope(
      ctx,
      await organizationServices().positions.list(ctx.tenantContext, {
        ...filter,
        limit: filter.limit ?? 100,
        offset: filter.offset ?? 0,
      })
    )
  }

  async show(ctx: HttpContext) {
    return envelope(
      ctx,
      await organizationServices().positions.get(ctx.tenantContext, idParam(ctx))
    )
  }

  async create(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(createPositionValidator)
    const position = await organizationServices().positions.create(ctx.tenantContext, input)
    ctx.response.status(201).header('location', `/api/v1/positions/${position.id}`)
    return envelope(ctx, position)
  }

  async update(ctx: HttpContext) {
    const input = await ctx.request.validateUsing(updatePositionValidator)
    return envelope(
      ctx,
      await organizationServices().positions.update(ctx.tenantContext, idParam(ctx), input)
    )
  }
}
