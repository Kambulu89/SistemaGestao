import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { BudgetService, PayableService } from '#modules/procurement/application/finance_service'
import { PAYABLE_STATUSES } from '#modules/procurement/domain/finance'

/**
 * Orçamento de compras por centro de custo e obrigações a pagar (9.10): âmbito por entidade legal verificado no
 * serviço (`procurement.budgets.*`, `procurement.payables.*`).
 */
const budgets = new BudgetService()
const payables = new PayableService()

const budgetQuery = vine.create(
  vine.object({
    fiscalYear: vine.number().withoutDecimals().min(2000).max(2200).optional(),
    legalEntityId: vine.string().uuid().optional(),
  })
)
const payableQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(PAYABLE_STATUSES).optional(),
    supplierId: vine.string().uuid().optional(),
    overdue: vine.boolean().optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(
  vine.object({ expectedVersion: vine.number().withoutDecimals().min(1) }).allowUnknownProperties()
)
const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const vbody = (ctx: HttpContext) =>
  ctx.request.validateUsing(versioned, { data: ctx.request.body() })

export default class FinanceController {
  async budgets(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(budgetQuery, { data: ctx.request.qs() })
    return ok(ctx, await budgets.list(ctx.tenantContext!, q))
  }

  async budgetOptions(ctx: HttpContext) {
    return ok(ctx, await budgets.options(ctx.tenantContext!))
  }

  async budget(ctx: HttpContext) {
    return ok(ctx, await budgets.movements(ctx.tenantContext!, param(ctx)))
  }

  async createBudget(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    return created(ctx, await budgets.create(ctx.tenantContext!, b))
  }

  async updateBudget(ctx: HttpContext) {
    return ok(ctx, await budgets.update(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async payables(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(payableQuery, { data: ctx.request.qs() })
    const p = await payables.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async payable(ctx: HttpContext) {
    return ok(ctx, await payables.get(ctx.tenantContext!, param(ctx)))
  }

  async pay(ctx: HttpContext) {
    return ok(ctx, await payables.pay(ctx.tenantContext!, param(ctx), await vbody(ctx)))
  }

  async retry(ctx: HttpContext) {
    return ok(ctx, await payables.retry(ctx.tenantContext!, param(ctx)))
  }
}
