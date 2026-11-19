import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { LoanService } from '#modules/hr/application/loan_service'

/**
 * Adiantamentos e empréstimos (7.6): âmbito `hr.loans.*` verificado no serviço (pela colocação do colaborador). Só o
 * corpo JSON é validado.
 */
const loans = new LoanService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const onlyVersion = vine.create(vine.object(version))
const listQuery = vine.create(
  vine.object({
    status: vine
      .enum(['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SETTLED', 'REJECTED', 'CANCELLED'] as const)
      .optional(),
    kind: vine.enum(['ADVANCE', 'LOAN'] as const).optional(),
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
const paymentBody = vine.create(
  vine.object({
    reference: vine.string().trim().minLength(1).maxLength(80),
    paidOn: vine.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: vine.string().trim().maxLength(1000).optional(),
    ...version,
  })
)

const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class LoansController {
  async forEmployee(ctx: HttpContext) {
    return ok(ctx, await loans.forEmployee(ctx.tenantContext!, param(ctx)))
  }

  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const page = await loans.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, page.items, { total: page.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await loans.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(
      ctx,
      await loans.create(ctx.tenantContext!, param(ctx), await body(ctx, anyBody))
    )
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await loans.update(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async submit(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await loans.submit(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async decide(ctx: HttpContext) {
    const b = await body(ctx, decisionBody)
    return ok(
      ctx,
      await loans.decide(
        ctx.tenantContext!,
        param(ctx),
        b.decision === 'APPROVE',
        b.comment || null,
        b.expectedVersion
      )
    )
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, onlyVersion)
    return ok(ctx, await loans.cancel(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async pay(ctx: HttpContext) {
    const b = await body(ctx, paymentBody)
    return ok(
      ctx,
      await loans.pay(
        ctx.tenantContext!,
        param(ctx),
        param(ctx, 'installmentId'),
        { reference: b.reference, paidOn: b.paidOn, note: b.note || null },
        b.expectedVersion
      )
    )
  }
}
