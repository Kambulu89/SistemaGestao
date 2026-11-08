import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { CareerService, ContractService } from '#modules/hr/application/career_service'

/**
 * Contratos e carreira (7.3). O âmbito (pelo colaborador) é verificado no serviço com `hr.contracts.read|manage` e
 * `hr.read|manage`. Só o corpo JSON é validado (nunca parâmetros, cabeçalhos ou cookies).
 */
const contracts = new ContractService()
const career = new CareerService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const onlyVersion = vine.create(vine.object(version))
const dated = vine.create(
  vine.object({
    date: vine.string().trim().maxLength(10),
    reason: vine.string().trim().maxLength(1000).optional(),
    ...version,
  })
)

const id = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = <T>(ctx: HttpContext, validator: { validate: (d: unknown) => Promise<T> } | any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<T>

export default class CareerController {
  async contracts(ctx: HttpContext) {
    return ok(ctx, await contracts.list(ctx.tenantContext!, id(ctx)))
  }

  async createContract(ctx: HttpContext) {
    const b = (await body(ctx, anyBody)) as Record<string, unknown>
    return created(ctx, await contracts.create(ctx.tenantContext!, id(ctx), b))
  }

  async contract(ctx: HttpContext) {
    return ok(ctx, await contracts.get(ctx.tenantContext!, id(ctx)))
  }

  async updateContract(ctx: HttpContext) {
    const { expectedVersion, ...b } = (await body(ctx, versioned)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return ok(ctx, await contracts.update(ctx.tenantContext!, id(ctx), b, expectedVersion))
  }

  async activate(ctx: HttpContext) {
    const { expectedVersion } = (await body(ctx, onlyVersion)) as { expectedVersion: number }
    return ok(
      ctx,
      await contracts.transition(ctx.tenantContext!, id(ctx), 'activate', {}, expectedVersion)
    )
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion } = (await body(ctx, onlyVersion)) as { expectedVersion: number }
    return ok(
      ctx,
      await contracts.transition(ctx.tenantContext!, id(ctx), 'cancel', {}, expectedVersion)
    )
  }

  async suspend(ctx: HttpContext) {
    return this.dated(ctx, 'suspend')
  }

  async resume(ctx: HttpContext) {
    return this.dated(ctx, 'resume')
  }

  async terminate(ctx: HttpContext) {
    return this.dated(ctx, 'terminate')
  }

  async amend(ctx: HttpContext) {
    const { expectedVersion, ...b } = (await body(ctx, versioned)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return created(ctx, await contracts.amend(ctx.tenantContext!, id(ctx), b, expectedVersion))
  }

  async assignments(ctx: HttpContext) {
    return ok(ctx, await career.list(ctx.tenantContext!, id(ctx)))
  }

  async move(ctx: HttpContext) {
    const { expectedVersion, ...b } = (await body(ctx, versioned)) as Record<string, unknown> & {
      expectedVersion: number
    }
    return created(ctx, await career.move(ctx.tenantContext!, id(ctx), b, expectedVersion))
  }

  private async dated(ctx: HttpContext, action: 'suspend' | 'resume' | 'terminate') {
    const b = (await body(ctx, dated)) as { date: string; reason?: string; expectedVersion: number }
    return ok(
      ctx,
      await contracts.transition(
        ctx.tenantContext!,
        id(ctx),
        action,
        { date: b.date, reason: b.reason },
        b.expectedVersion
      )
    )
  }
}
