import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'
import { created, ok } from '#shared/http/respond'
import { isUuid } from '#shared/db/sql'
import { ProductService } from '#modules/inventory/application/product_service'
import { CatalogSettingsService } from '#modules/inventory/application/catalog_settings_service'

/**
 * Catálogo do inventário (8.1). Permissões nas rotas: `inventory.read` (consultar), `inventory.products.manage`
 * (produtos e variantes) e `inventory.settings` (unidades, categorias e marcas). Só o corpo JSON é validado aqui.
 */
const products = new ProductService()
const settings = new CatalogSettingsService()

const version = { expectedVersion: vine.number().withoutDecimals().min(0) }
const anyBody = vine.create(vine.object({}).allowUnknownProperties())
const versioned = vine.create(vine.object(version).allowUnknownProperties())
const listQuery = vine.create(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    categoryId: vine.string().uuid().optional(),
    brandId: vine.string().uuid().optional(),
    productType: vine.enum(['STOCKABLE', 'SERVICE', 'KIT'] as const).optional(),
    status: vine.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED'] as const).optional(),
    sort: vine.enum(['sku', 'name', 'createdAt'] as const).optional(),
    direction: vine.enum(['asc', 'desc'] as const).optional(),
    limit: vine.number().withoutDecimals().min(1).max(200).optional(),
    offset: vine.number().withoutDecimals().min(0).optional(),
  })
)
const lookupQuery = vine.create(
  vine.object({ code: vine.string().trim().minLength(1).maxLength(48) })
)

const param = (ctx: HttpContext, name = 'id') => {
  const v = ctx.params[name] as string
  if (!isUuid(v)) throw ApiError.notFound()
  return v
}
const body = (ctx: HttpContext, validator: any) =>
  ctx.request.validateUsing(validator, { data: ctx.request.body() }) as Promise<any>
const KINDS = { uoms: 'uoms', categories: 'categories', brands: 'brands' } as const

export default class CatalogController {
  async index(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listQuery, { data: ctx.request.qs() })
    const p = await products.list(ctx.tenantContext!, {
      ...q,
      sort: q.sort ? { field: q.sort, direction: q.direction ?? 'asc' } : undefined,
      limit: q.limit ?? 25,
      offset: q.offset ?? 0,
    })
    return ok(ctx, p.items, { total: p.total })
  }

  async show(ctx: HttpContext) {
    return ok(ctx, await products.get(ctx.tenantContext!, param(ctx)))
  }

  async lookup(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(lookupQuery, { data: ctx.request.qs() })
    return ok(ctx, await products.lookup(ctx.tenantContext!, q.code))
  }

  async store(ctx: HttpContext) {
    return created(ctx, await products.save(ctx.tenantContext!, null, await body(ctx, anyBody)))
  }

  async update(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await products.save(ctx.tenantContext!, param(ctx), b, expectedVersion))
  }

  async storeVariant(ctx: HttpContext) {
    return created(
      ctx,
      await products.saveVariant(ctx.tenantContext!, param(ctx), null, await body(ctx, anyBody))
    )
  }

  async updateVariant(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(
      ctx,
      await products.saveVariant(ctx.tenantContext!, null, param(ctx), b, expectedVersion)
    )
  }

  async settingsList(ctx: HttpContext) {
    const kind = KINDS[ctx.params.kind as keyof typeof KINDS]
    if (!kind) throw ApiError.notFound()
    return ok(ctx, await settings.list(ctx.tenantContext!, kind))
  }

  async settingsCreate(ctx: HttpContext) {
    return created(ctx, await this.save(ctx, null, await body(ctx, anyBody)))
  }

  async settingsUpdate(ctx: HttpContext) {
    const { expectedVersion, ...b } = await body(ctx, versioned)
    return ok(ctx, await this.save(ctx, param(ctx), b, expectedVersion))
  }

  private save(ctx: HttpContext, id: string | null, b: Record<string, unknown>, v?: number) {
    const c = ctx.tenantContext!
    switch (ctx.params.kind) {
      case 'uoms':
        return settings.saveUom(c, id, b, v)
      case 'categories':
        return settings.saveCategory(c, id, b, v)
      case 'brands':
        return settings.saveBrand(c, id, b, v)
      default:
        throw ApiError.notFound()
    }
  }
}
