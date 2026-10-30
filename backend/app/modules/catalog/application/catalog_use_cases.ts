import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  categoryIssues,
  normalizeProduct,
  normalizeVariant,
  stockIdentityChanged,
  type Issue,
  type ProductInput,
  type ProductType,
  type VariantInput,
} from '#modules/catalog/domain/catalog'
import type {
  Category,
  CategoryStore,
  Product,
  ProductStore,
  References,
  Variant,
  VariantStore,
} from '#modules/catalog/application/ports'
import { hasMovements } from '#modules/catalog/application/registry'

export const catalogValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

const MAX_PAGE = 200

export interface ProductDetail extends Product {
  variants: Variant[]
}

/** Categorias, produtos e variantes (M03). Nada se apaga: desactiva-se. O SKU identifica sempre uma variante. */
export class CatalogUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly categories: CategoryStore,
    private readonly products: ProductStore,
    private readonly variants: VariantStore,
    private readonly references: References
  ) {}

  // --- categorias ----------------------------------------------------------------------------

  listCategories(context: TenantContext): Promise<Category[]> {
    return this.uow.run((scope) => this.categories.list(scope), context)
  }

  async createCategory(
    context: TenantContext,
    input: { code: string; name: string; parentId?: string | null }
  ): Promise<Category> {
    const issues = categoryIssues(input, true)
    if (issues.length > 0) throw catalogValidation(issues)
    return this.uow.run(async (scope) => {
      const parentId = input.parentId ?? null
      if (parentId && !(await this.categories.find(scope, parentId))) {
        throw catalogValidation([
          {
            path: 'parentId',
            code: 'UNKNOWN_CATEGORY',
            message: 'A categoria superior não existe.',
          },
        ])
      }
      const created = await this.categories.insert(scope, {
        code: input.code.trim(),
        name: input.name.trim(),
        parentId,
      })
      if (!created) {
        throw ApiError.conflict('CATEGORY_CODE_TAKEN', 'Já existe uma categoria com este código.')
      }
      return created
    }, context)
  }

  async updateCategory(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; name?: string; parentId?: string | null }
  ): Promise<Category> {
    const issues = categoryIssues(input, false)
    if (issues.length > 0) throw catalogValidation(issues)
    return this.uow.run(async (scope) => {
      const current = await this.categories.find(scope, id)
      if (!current) throw ApiError.notFound()
      if (input.parentId !== undefined && input.parentId !== null) {
        if (!(await this.categories.find(scope, input.parentId))) {
          throw catalogValidation([
            {
              path: 'parentId',
              code: 'UNKNOWN_CATEGORY',
              message: 'A categoria superior não existe.',
            },
          ])
        }
        // Uma categoria não pode ficar debaixo de si própria nem de uma descendente.
        const all = await this.categories.list(scope)
        const byId = new Map(all.map((c) => [c.id, c]))
        for (let cursor: string | null = input.parentId, hops = 0; cursor && hops < 1000; hops++) {
          if (cursor === id) {
            throw ApiError.conflict('CATEGORY_CYCLE', 'A categoria ficaria debaixo de si própria.')
          }
          cursor = byId.get(cursor)?.parentId ?? null
        }
      }
      return this.categories.update(scope, id, input.expectedVersion, {
        name: input.name?.trim(),
        parentId: input.parentId,
      })
    }, context)
  }

  // --- produtos ------------------------------------------------------------------------------

  async listProducts(
    context: TenantContext,
    filter: {
      q?: string
      type?: ProductType
      categoryId?: string
      active?: boolean
      limit?: number
      offset?: number
    }
  ): Promise<{ items: Product[]; total: number }> {
    return this.uow.run(
      (scope) =>
        this.products.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  getProduct(context: TenantContext, id: string): Promise<ProductDetail> {
    return this.uow.run(async (scope) => {
      const product = await this.products.find(scope, id)
      if (!product) throw ApiError.notFound()
      return { ...product, variants: await this.variants.listByProduct(scope, id) }
    }, context)
  }

  /**
   * Cria o produto e a sua **variante por omissão** (SKU indicado, ou o código do produto): um produto simples nunca fica
   * sem variante, porque são as variantes que as linhas comerciais e o stock referenciam.
   */
  async createProduct(
    context: TenantContext,
    input: ProductInput & { sku?: string; barcode?: string | null; attributes?: unknown }
  ): Promise<ProductDetail> {
    const issues: Issue[] = []
    const values = normalizeProduct(input, null, issues)
    const variantValues = values
      ? normalizeVariant(
          { sku: input.sku ?? values.code, barcode: input.barcode, attributes: input.attributes },
          null,
          issues
        )
      : null
    if (issues.length > 0 || !values || !variantValues) throw catalogValidation(issues)
    await this.checkReferences(context, values)

    return this.uow.run(async (scope) => {
      const created = await this.products.insert(scope, values)
      if (!created)
        throw ApiError.conflict('PRODUCT_CODE_TAKEN', 'Já existe um produto com este código.')
      const variant = await this.variants.insert(scope, created.id, variantValues, true)
      if (variant === 'SKU') throw this.skuTaken()
      if (variant === 'BARCODE') throw this.barcodeTaken()
      return { ...created, variants: [variant] }
    }, context)
  }

  async updateProduct(
    context: TenantContext,
    id: string,
    input: ProductInput & { expectedVersion: number }
  ): Promise<ProductDetail> {
    const current = await this.uow.run((scope) => this.products.find(scope, id), context)
    if (!current) throw ApiError.notFound()
    const issues: Issue[] = []
    if (input.code !== undefined && input.code !== current.code) {
      issues.push({
        path: 'code',
        code: 'CODE_IMMUTABLE',
        message: 'O código do produto não se altera.',
      })
    }
    const values = normalizeProduct(input, current, issues)
    if (issues.length > 0 || !values) throw catalogValidation(issues)
    await this.checkReferences(context, values, current)

    return this.uow.run(async (scope) => {
      // Mudar a unidade base ou o rastreio com movimentos exige migração, não uma edição simples.
      if (stockIdentityChanged(current, values) && (await hasMovements(scope, id))) {
        throw ApiError.conflict(
          'STOCK_MIGRATION_REQUIRED',
          'O produto já tem movimentos de stock: mudar a unidade base ou o rastreio exige uma migração.'
        )
      }
      const updated = await this.products.update(scope, id, input.expectedVersion, values)
      return { ...updated, variants: await this.variants.listByProduct(scope, id) }
    }, context)
  }

  // --- variantes -----------------------------------------------------------------------------

  listVariants(context: TenantContext, productId: string): Promise<Variant[]> {
    return this.uow.run(async (scope) => {
      if (!(await this.products.find(scope, productId))) throw ApiError.notFound()
      return this.variants.listByProduct(scope, productId)
    }, context)
  }

  getVariant(context: TenantContext, id: string): Promise<Variant & { product: Product }> {
    return this.uow.run(async (scope) => {
      const variant = await this.variants.find(scope, id)
      if (!variant) throw ApiError.notFound()
      const product = (await this.products.find(scope, variant.productId)) as Product
      return { ...variant, product }
    }, context)
  }

  async createVariant(
    context: TenantContext,
    productId: string,
    input: VariantInput
  ): Promise<Variant> {
    const issues: Issue[] = []
    const values = normalizeVariant(input, null, issues)
    if (issues.length > 0 || !values) throw catalogValidation(issues)
    return this.uow.run(async (scope) => {
      if (!(await this.products.find(scope, productId))) throw ApiError.notFound()
      const created = await this.variants.insert(scope, productId, values, false)
      if (created === 'SKU') throw this.skuTaken()
      if (created === 'BARCODE') throw this.barcodeTaken()
      return created
    }, context)
  }

  async updateVariant(
    context: TenantContext,
    id: string,
    input: VariantInput & { expectedVersion: number }
  ): Promise<Variant> {
    return this.uow.run(async (scope) => {
      const current = await this.variants.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeVariant(input, current, issues)
      if (issues.length > 0 || !values) throw catalogValidation(issues)
      // A variante por omissão não se desactiva: o produto ficaria sem variante utilizável.
      if (current.isDefault && !values.active) {
        throw ApiError.conflict(
          'DEFAULT_VARIANT_ACTIVE',
          'A variante por omissão não se desactiva: desactive o produto ou escolha outra por omissão.'
        )
      }
      const updated = await this.variants.update(scope, id, input.expectedVersion, values)
      if (updated === 'BARCODE') throw this.barcodeTaken()
      return updated
    }, context)
  }

  // --- internos ------------------------------------------------------------------------------

  private skuTaken() {
    return ApiError.conflict('SKU_TAKEN', 'Já existe uma variante com este SKU.')
  }

  private barcodeTaken() {
    return ApiError.conflict('BARCODE_TAKEN', 'Já existe uma variante com este código de barras.')
  }

  private async checkReferences(
    context: TenantContext,
    values: { baseUnitId: string; categoryId: string | null },
    before?: Product
  ) {
    const issues: Issue[] = []
    if (
      values.baseUnitId !== before?.baseUnitId &&
      !(await this.references.unitExists(context, values.baseUnitId))
    ) {
      issues.push({
        path: 'baseUnitId',
        code: 'UNKNOWN_UNIT',
        message: 'A unidade base não existe.',
      })
    }
    if (values.categoryId && values.categoryId !== before?.categoryId) {
      const found = await this.uow.run(
        (scope: TenantScope) => this.categories.find(scope, values.categoryId as string),
        context
      )
      if (!found)
        issues.push({
          path: 'categoryId',
          code: 'UNKNOWN_CATEGORY',
          message: 'A categoria não existe.',
        })
    }
    if (issues.length > 0) throw catalogValidation(issues)
  }
}
