import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  CURRENCY,
  MONEY,
  RATE,
  isIsoDate,
  isPositiveQuantity,
  normalizePriceItem,
  normalizePriceList,
  pickPrice,
  type Issue,
  type PriceItemValues,
  type PriceListInput,
} from '#modules/catalog/domain/catalog'
import type {
  PriceItem,
  PriceList,
  PriceStore,
  Product,
  ProductStore,
  References,
  VariantStore,
} from '#modules/catalog/application/ports'
import { catalogValidation } from '#modules/catalog/application/catalog_use_cases'

export interface ResolvedPrice {
  variantId: string
  sku: string
  productId: string
  productType: string
  quantity: string
  date: string
  currency: string
  priceListId: string
  priceListName: string
  priority: number
  taxInclusive: boolean
  /** O escalão que se aplicou. */
  minQuantity: string
  unitPrice: string
  maxDiscount: string
  validFrom: string
  validTo: string | null
}

/**
 * Tabelas de preços e resolução de preço (M03). A resolução devolve o preço **e a sua origem**: o documento que o usar
 * guarda esse snapshot na linha, por isso editar a tabela depois nunca altera documentos anteriores.
 */
export class PriceUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly prices: PriceStore,
    private readonly products: ProductStore,
    private readonly variants: VariantStore,
    private readonly references: References,
    private readonly clock: () => Date = () => new Date()
  ) {}

  listLists(context: TenantContext, filter: { organizationId?: string }): Promise<PriceList[]> {
    return this.uow.run((scope) => this.prices.listLists(scope, filter), context)
  }

  getList(context: TenantContext, id: string): Promise<PriceList & { items: PriceItem[] }> {
    return this.uow.run(async (scope) => {
      const list = await this.prices.findList(scope, id)
      if (!list) throw ApiError.notFound()
      return { ...list, items: await this.prices.listItems(scope, id) }
    }, context)
  }

  async createList(context: TenantContext, input: PriceListInput): Promise<PriceList> {
    const issues: Issue[] = []
    const values = normalizePriceList(input, null, issues)
    if (issues.length > 0 || !values) throw catalogValidation(issues)
    if (!(await this.references.organizationExists(context, values.organizationId))) {
      throw catalogValidation([
        {
          path: 'organizationId',
          code: 'UNKNOWN_ORGANIZATION',
          message: 'A organização não existe.',
        },
      ])
    }
    return this.uow.run(async (scope) => {
      const created = await this.prices.insertList(scope, values)
      if (!created) {
        throw ApiError.conflict(
          'PRICE_LIST_NAME_TAKEN',
          'Já existe uma tabela com este nome nesta organização.'
        )
      }
      return created
    }, context)
  }

  async updateList(
    context: TenantContext,
    id: string,
    input: PriceListInput & { expectedVersion: number }
  ): Promise<PriceList> {
    return this.uow.run(async (scope) => {
      const current = await this.prices.findList(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizePriceList(input, current, issues)
      if (issues.length > 0 || !values) throw catalogValidation(issues)
      const updated = await this.prices.updateList(scope, id, input.expectedVersion, values)
      if (updated === 'NAME_TAKEN') {
        throw ApiError.conflict(
          'PRICE_LIST_NAME_TAKEN',
          'Já existe uma tabela com este nome nesta organização.'
        )
      }
      return updated
    }, context)
  }

  async addItem(
    context: TenantContext,
    priceListId: string,
    input: {
      variantId?: unknown
      minQuantity?: unknown
      unitPrice?: unknown
      maxDiscount?: unknown
    }
  ): Promise<PriceItem> {
    const issues: Issue[] = []
    const values = normalizePriceItem(input, issues)
    if (issues.length > 0 || !values) throw catalogValidation(issues)
    return this.uow.run(async (scope) => {
      if (!(await this.prices.findList(scope, priceListId))) throw ApiError.notFound()
      const variant = await this.variants.find(scope, values.variantId)
      if (!variant) {
        throw catalogValidation([
          { path: 'variantId', code: 'UNKNOWN_VARIANT', message: 'A variante não existe.' },
        ])
      }
      if (!variant.active) {
        throw catalogValidation([
          { path: 'variantId', code: 'VARIANT_INACTIVE', message: 'A variante está desactivada.' },
        ])
      }
      const created = await this.prices.insertItem(scope, priceListId, values as PriceItemValues)
      if (!created) {
        throw ApiError.conflict(
          'PRICE_TIER_EXISTS',
          'Esta variante já tem um preço para este escalão de quantidade na tabela.'
        )
      }
      return created
    }, context)
  }

  async updateItem(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; unitPrice?: unknown; maxDiscount?: unknown }
  ): Promise<PriceItem> {
    return this.uow.run(async (scope) => {
      const current = await this.prices.findItem(scope, id)
      if (!current) throw ApiError.notFound()
      const unitPrice = input.unitPrice ?? current.unitPrice
      const maxDiscount = input.maxDiscount ?? current.maxDiscount
      const issues: Issue[] = []
      if (typeof unitPrice !== 'string' || !MONEY.test(unitPrice)) {
        issues.push({
          path: 'unitPrice',
          code: 'INVALID_PRICE',
          message: 'Preço: decimal não negativo em texto.',
        })
      }
      if (typeof maxDiscount !== 'string' || !RATE.test(maxDiscount)) {
        issues.push({
          path: 'maxDiscount',
          code: 'INVALID_DISCOUNT',
          message: 'Desconto máximo: taxa entre 0 e 1 em texto.',
        })
      }
      if (issues.length > 0) throw catalogValidation(issues)
      return this.prices.updateItem(scope, id, input.expectedVersion, {
        unitPrice: unitPrice as string,
        maxDiscount: maxDiscount as string,
      })
    }, context)
  }

  deleteItem(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      if (!(await this.prices.deleteItem(scope, id))) throw ApiError.notFound()
    }, context)
  }

  async resolve(
    context: TenantContext,
    query: {
      variantId: string
      organizationId: string
      currency: string
      quantity: string
      date?: string
    }
  ): Promise<ResolvedPrice> {
    const issues: Issue[] = []
    if (!CURRENCY.test(query.currency)) {
      issues.push({
        path: 'currency',
        code: 'INVALID_CURRENCY',
        message: 'Moeda: 3 letras maiúsculas.',
      })
    }
    if (!isPositiveQuantity(query.quantity)) {
      issues.push({
        path: 'quantity',
        code: 'INVALID_QUANTITY',
        message: 'Quantidade: decimal positivo em texto.',
      })
    }
    const date = query.date ?? this.clock().toISOString().slice(0, 10)
    if (!isIsoDate(date)) {
      issues.push({ path: 'date', code: 'INVALID_DATE', message: 'Data inválida (AAAA-MM-DD).' })
    }
    if (issues.length > 0) throw catalogValidation(issues)

    return this.uow.run(async (scope) => {
      const variant = await this.variants.find(scope, query.variantId)
      if (!variant) throw ApiError.notFound()
      const product = (await this.products.find(scope, variant.productId)) as Product
      if (!variant.active || !product.active) {
        throw ApiError.conflict('VARIANT_INACTIVE', 'A variante ou o produto está desactivado.')
      }
      const candidates = await this.prices.candidates(scope, {
        variantId: variant.id,
        organizationId: query.organizationId,
        currency: query.currency,
        date,
        quantity: query.quantity,
      })
      const picked = pickPrice(candidates)
      if (picked.kind === 'NONE') {
        throw new ApiError(
          404,
          'PRICE_NOT_FOUND',
          'Não há preço aplicável a esta variante, moeda, data e quantidade.'
        )
      }
      if (picked.kind === 'AMBIGUOUS') {
        throw new ApiError(
          409,
          'PRICE_AMBIGUOUS',
          'Mais de uma tabela de preços aplicável tem a mesma prioridade: ajuste as prioridades.',
          picked.lists.map((l) => ({ path: 'priceList', code: 'TIED_LIST', message: l.name }))
        )
      }
      const price = picked.price
      return {
        variantId: variant.id,
        sku: variant.sku,
        productId: product.id,
        productType: product.type,
        quantity: query.quantity,
        date,
        currency: price.currency,
        priceListId: price.priceListId,
        priceListName: price.priceListName,
        priority: price.priority,
        taxInclusive: price.taxInclusive,
        minQuantity: price.minQuantity,
        unitPrice: price.unitPrice,
        maxDiscount: price.maxDiscount,
        validFrom: price.validFrom,
        validTo: price.validTo,
      }
    }, context)
  }
}
