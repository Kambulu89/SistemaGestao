import type { HttpContext } from '@adonisjs/core/http'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { isUuid } from '#core/tenancy/index'
import { catalogServices } from '#modules/catalog/presentation/composition'
import {
  createCategoryValidator,
  createPriceItemValidator,
  createPriceListValidator,
  createProductValidator,
  createVariantValidator,
  listPriceListsValidator,
  listProductsValidator,
  resolvePriceValidator,
  updateCategoryValidator,
  updatePriceItemValidator,
  updatePriceListValidator,
  updateProductValidator,
  updateVariantValidator,
} from '#modules/catalog/presentation/validators'

/** Um id mal formado é "inexistente" (404), tal como um id de outro tenant. */
function uuidParam(ctx: HttpContext, name: string): string {
  const id = ctx.params[name] as string
  if (!isUuid(id)) throw ApiError.notFound()
  return id
}

/** Transporte apenas: valida, chama o caso de uso e formata a resposta. */
export default class CatalogController {
  // --- categorias ----------------------------------------------------------------------------

  async listCategories(ctx: HttpContext) {
    return envelope(ctx, await catalogServices().catalog.listCategories(ctx.tenantContext))
  }

  async createCategory(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createCategoryValidator)
    const created = await catalogServices().catalog.createCategory(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/product-categories/${created.id}`)
    return envelope(ctx, created)
  }

  async updateCategory(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateCategoryValidator)
    return envelope(
      ctx,
      await catalogServices().catalog.updateCategory(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  // --- produtos ------------------------------------------------------------------------------

  async listProducts(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listProductsValidator, { data: ctx.request.qs() })
    const { items, total } = await catalogServices().catalog.listProducts(ctx.tenantContext, q)
    return envelope(ctx, items, { total })
  }

  async showProduct(ctx: HttpContext) {
    return envelope(
      ctx,
      await catalogServices().catalog.getProduct(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createProduct(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createProductValidator)
    const created = await catalogServices().catalog.createProduct(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/products/${created.id}`)
    return envelope(ctx, created)
  }

  async updateProduct(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateProductValidator)
    return envelope(
      ctx,
      await catalogServices().catalog.updateProduct(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  // --- variantes -----------------------------------------------------------------------------

  async listVariants(ctx: HttpContext) {
    return envelope(
      ctx,
      await catalogServices().catalog.listVariants(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async showVariant(ctx: HttpContext) {
    return envelope(
      ctx,
      await catalogServices().catalog.getVariant(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createVariant(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createVariantValidator)
    const created = await catalogServices().catalog.createVariant(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201).header('location', `/api/v1/variants/${created.id}`)
    return envelope(ctx, created)
  }

  async updateVariant(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updateVariantValidator)
    return envelope(
      ctx,
      await catalogServices().catalog.updateVariant(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  // --- tabelas de preços ---------------------------------------------------------------------

  async listPriceLists(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(listPriceListsValidator, { data: ctx.request.qs() })
    return envelope(ctx, await catalogServices().prices.listLists(ctx.tenantContext, q))
  }

  async showPriceList(ctx: HttpContext) {
    return envelope(
      ctx,
      await catalogServices().prices.getList(ctx.tenantContext, uuidParam(ctx, 'id'))
    )
  }

  async createPriceList(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createPriceListValidator)
    const created = await catalogServices().prices.createList(ctx.tenantContext, b)
    ctx.response.status(201).header('location', `/api/v1/price-lists/${created.id}`)
    return envelope(ctx, created)
  }

  async updatePriceList(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updatePriceListValidator)
    return envelope(
      ctx,
      await catalogServices().prices.updateList(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async addPriceItem(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(createPriceItemValidator)
    const created = await catalogServices().prices.addItem(
      ctx.tenantContext,
      uuidParam(ctx, 'id'),
      b
    )
    ctx.response.status(201)
    return envelope(ctx, created)
  }

  async updatePriceItem(ctx: HttpContext) {
    const b = await ctx.request.validateUsing(updatePriceItemValidator)
    return envelope(
      ctx,
      await catalogServices().prices.updateItem(ctx.tenantContext, uuidParam(ctx, 'id'), b)
    )
  }

  async deletePriceItem(ctx: HttpContext) {
    await catalogServices().prices.deleteItem(ctx.tenantContext, uuidParam(ctx, 'id'))
    ctx.response.status(204)
  }

  async resolvePrice(ctx: HttpContext) {
    const q = await ctx.request.validateUsing(resolvePriceValidator, { data: ctx.request.qs() })
    return envelope(ctx, await catalogServices().prices.resolve(ctx.tenantContext, q))
  }
}
