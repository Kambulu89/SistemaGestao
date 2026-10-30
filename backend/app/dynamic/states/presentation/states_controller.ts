import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { stateServices } from '#dynamic/states/presentation/composition'
import {
  createMachineValidator,
  listMachinesValidator,
  transitionValidator,
  updateMachineValidator,
  versionOnlyValidator,
} from '#dynamic/states/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class StatesController {
  async list(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listMachinesValidator, { data: ctx.request.qs() })
    return envelope(ctx, await stateServices().machines.list(ctx.tenantContext, q))
  }

  async show(ctx: HttpContext) {
    return envelope(
      ctx,
      await stateServices().machines.get(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async create(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createMachineValidator)
    const machine = await stateServices().machines.create(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/state-machines/${machine.id}`)
    return envelope(ctx, machine)
  }

  async update(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateMachineValidator)
    return envelope(
      ctx,
      await stateServices().machines.update(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async createRevision(ctx: HttpContext) {
    const machine = await stateServices().machines.createRevision(
      ctx.tenantContext,
      uuidParam(ctx, 'id')
    )
    ctx.response.status(201).header('location', `/api/v1/state-machines/${machine.id}`)
    return envelope(ctx, machine)
  }

  async preview(ctx: HttpContext) {
    return envelope(
      ctx,
      await stateServices().machines.preview(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async publish(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await stateServices().machines.publish(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }

  async retire(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(versionOnlyValidator)
    return envelope(
      ctx,
      await stateServices().machines.retire(
        ctx.tenantContext,
        uuidParam(ctx, 'id'),
        b.expectedVersion
      )
    )
  }

  async availableActions(ctx: HttpContext) {
    return envelope(
      ctx,
      await stateServices().transitions.availableActions(
        ctx.tenantContext,
        ctx.params.entityCode as string,
        uuidParam(ctx, 'id')
      )
    )
  }

  async transition(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(transitionValidator)
    return envelope(
      ctx,
      await stateServices().transitions.execute(
        ctx.tenantContext,
        ctx.params.entityCode as string,
        uuidParam(ctx, 'id'),
        ctx.params.code as string,
        b
      )
    )
  }

  async history(ctx: HttpContext) {
    return envelope(
      ctx,
      await stateServices().transitions.history(
        ctx.tenantContext,
        ctx.params.entityCode as string,
        uuidParam(ctx, 'id')
      )
    )
  }
}
