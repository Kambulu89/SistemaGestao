import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import {
  CompensationService,
  PayComponentService,
} from '#modules/hr/application/compensation_service'

/**
 * Compensação e benefícios (7.5). Catálogo e incidências: `hr.compensation.settings` (rota); propostas e remuneração
 * do colaborador: âmbito `hr.compensation.*` verificado no serviço. Só o corpo JSON é validado.
 */
const components = new PayComponentService()
const compensation = new CompensationService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const onlyVersion = vine.create(vine.object(version))
const dateQuery = vine.create(
  vine.object({
    date: vine
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
)
const listQuery = vine.create(
  vine.object({
    status: vine
      .enum(['DRAFT', 'PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'CANCELLED'] as const)
      .optional(),
    toApprove: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const decisionBody = vine.create(
  vine.object({
    decision: vine.enum(['APPROVE', 'REJECT'] as const),
    comment: vine.string().trim().maxLength(1000).optional(),
    ...version,
  })
)

const id = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class CompensationController {
  async components(ctx: HttpContext) {
    return ok(ctx, await components.list(ctx.tenantContext!))
  }

  async component(ctx: HttpContext) {
    return ok(ctx, await components.get(ctx.tenantContext!, id(ctx)))
  }

  async createComponent(ctx: HttpContext) {
    return created(ctx, await components.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async updateComponent(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await components.update(ctx.tenantContext!, id(ctx), b, expectedVersion))
  }

  async addIncidence(ctx: HttpContext) {
    return created(
      ctx,
      await components.addIncidence(ctx.tenantContext!, id(ctx), await body(ctx, anyBody))
    )
  }

  async summary(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(dateQuery, { data: ctx.request.qs() })
    return ok(
      ctx,
      await compensation.summary(
        ctx.tenantContext!,
        id(ctx),
        q.date ?? new Date().toISOString().slice(0, 10)
      )
    )
  }

  async proposals(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const page = await compensation.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async proposal(ctx: HttpContext) {
    return ok(ctx, await compensation.get(ctx.tenantContext!, id(ctx)))
  }

  async createProposal(ctx: HttpContext) {
    return created(
      ctx,
      await compensation.create(ctx.tenantContext!, id(ctx), await body(ctx, anyBody))
    )
  }

  async updateProposal(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await compensation.update(ctx.tenantContext!, id(ctx), b, expectedVersion))
  }

  async submit(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await compensation.submit(ctx.tenantContext!, id(ctx), expectedVersion))
  }

  async decide(ctx: HttpContext) {
    const b = await body(ctx, decisionBody)
    return ok(
      ctx,
      await compensation.decide(
        ctx.tenantContext!,
        id(ctx),
        b.decision === 'APPROVE',
        b.comment || null,
        b.expectedVersion
      )
    )
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await compensation.cancel(ctx.tenantContext!, id(ctx), expectedVersion))
  }
}
