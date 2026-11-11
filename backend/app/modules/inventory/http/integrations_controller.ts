import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { IntegrationService } from '#modules/inventory/application/integration_service'
import { InventoryAccountingService } from '#modules/inventory/application/accounting_bridge'
import { INTEGRATION_KINDS, type IntegrationKind } from '#modules/inventory/domain/integrations'

/**
 * Integrações (8.10): pedidos de Compras/Vendas/sistemas externos com `inventory.integrations.post` no âmbito do
 * armazém; registo pelos armazéns consultáveis; eventos contabilísticos com `inventory.valuation.read` ou
 * `inventory.accounting.manage` (repetir) por entidade legal — verificados no serviço.
 */
const integrations = new IntegrationService()
const accounting = new InventoryAccountingService()

const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const listQuery = vine.create(
  vine.object({
    kind: vine.enum(INTEGRATION_KINDS).optional(),
    warehouseId: vine.string().uuid().optional(),
    orderRef: vine.string().trim().maxLength(80).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const orderQuery = vine.create(
  vine.object({
    warehouseId: vine.string().uuid(),
    orderRef: vine.string().trim().minLength(1).maxLength(80),
  })
)
const accountingQuery = vine.create(
  vine.object({
    status: vine.enum(['PENDING', 'POSTED', 'DRAFTED', 'FAILED']).optional(),
    legalEntityId: vine.string().uuid().optional(),
    event: vine.string().trim().maxLength(40).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const KIND_OF: Record<string, IntegrationKind> = {
  'purchase-receipts': 'PURCHASE_RECEIPT',
  'sale-reservations': 'SALE_RESERVATION',
  'sale-releases': 'SALE_RELEASE',
  'sale-deliveries': 'SALE_DELIVERY',
  'sale-returns': 'SALE_RETURN',
}

export default class IntegrationsController {
  async post(ctx: HttpContext) {
    const kind = KIND_OF[ctx.params.kind as string]
    if (!kind) throw ApiError.notFound()
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    const r = await integrations.post(ctx.tenantContext!, kind, b)
    return r.replayed ? ok(ctx, r) : created(ctx, r)
  }

  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await integrations.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async order(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(orderQuery, { data: ctx.request.qs() })
    return ok(ctx, await integrations.order(ctx.tenantContext!, q.warehouseId, q.orderRef))
  }

  async accountingEvents(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(accountingQuery, { data: ctx.request.qs() })
    const p = await accounting.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async retry(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(anyBody, { data: ctx.request.body() })
    if (b.ids !== undefined && (!Array.isArray(b.ids) || !b.ids.every((x: unknown) => isUuid(x))))
      throw ApiError.validation([
        { path: 'ids', code: 'INVALID', message: 'Identificadores inválidos.' },
      ])
    return ok(ctx, await accounting.retry(ctx.tenantContext!, b))
  }
}
