import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { StockDocumentService } from '#modules/inventory/application/stock_document_service'
import { DOC_STATUSES, DOC_TYPES } from '#modules/inventory/domain/documents'

/**
 * Entradas e saídas (8.4): âmbito de inventory.documents.manage / inventory.documents.confirm sobre o armazém
 * (entidade legal ou filial), acesso de operação e consulta pelo acesso aos armazéns — verificados no serviço.
 */
const docs = new StockDocumentService()

const listQuery = vine.create(
  vine.object({
    docType: vine.enum(DOC_TYPES).optional(),
    status: vine.enum(DOC_STATUSES).optional(),
    warehouseId: vine.string().uuid().optional(),
    q: vine.string().trim().maxLength(100).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())

const param = (ctx: HttpContext) => {
  const v = ctx.params.id as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>

export default class StockDocumentsController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await docs.list(ctx.tenantContext!, {
      ...q,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await docs.get(ctx.tenantContext!, param(ctx)))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await docs.create(ctx.tenantContext!, await body(ctx, anyBody)))
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await docs.update(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async check(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await docs.check(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async reopen(ctx: HttpContext) {
    const { expectedVersion } = await body(ctx, versioned)
    return ok(ctx, await docs.reopen(ctx.tenantContext!, param(ctx), expectedVersion))
  }

  async confirm(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await docs.confirm(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async close(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await docs.close(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async cancel(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await docs.cancel(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async reverse(ctx: HttpContext) {
    return ok(ctx, await docs.reverse(ctx.tenantContext!, param(ctx), await body(ctx, anyBody)))
  }
}
