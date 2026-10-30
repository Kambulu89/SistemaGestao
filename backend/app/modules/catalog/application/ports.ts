import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  CategoryValues,
  PriceCandidate,
  PriceItemValues,
  PriceListValues,
  ProductType,
  ProductValues,
  VariantValues,
} from '#modules/catalog/domain/catalog'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface Category extends Audited, CategoryValues {}
export interface Product extends Audited, ProductValues {}
export interface Variant extends Audited, VariantValues {
  productId: string
  isDefault: boolean
}
export interface PriceList extends Audited, PriceListValues {}
export interface PriceItem extends Audited, PriceItemValues {
  priceListId: string
  sku: string
}

export interface ProductFilter {
  q?: string
  type?: ProductType
  categoryId?: string
  active?: boolean
  limit: number
  offset: number
}

export interface CategoryStore {
  list(scope: TenantScope): Promise<Category[]>
  find(scope: TenantScope, id: string): Promise<Category | null>
  /** `null` se o código já existir. */
  insert(scope: TenantScope, values: CategoryValues): Promise<Category | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<CategoryValues, 'name' | 'parentId'>>
  ): Promise<Category>
}

export interface ProductStore {
  list(scope: TenantScope, filter: ProductFilter): Promise<{ items: Product[]; total: number }>
  find(scope: TenantScope, id: string): Promise<Product | null>
  /** `null` se o código já existir. */
  insert(scope: TenantScope, values: ProductValues): Promise<Product | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: ProductValues
  ): Promise<Product>
}

export interface VariantStore {
  listByProduct(scope: TenantScope, productId: string): Promise<Variant[]>
  find(scope: TenantScope, id: string): Promise<Variant | null>
  /** `'SKU'` ou `'BARCODE'` se já existirem; senão a variante criada. */
  insert(
    scope: TenantScope,
    productId: string,
    values: VariantValues,
    isDefault: boolean
  ): Promise<Variant | 'SKU' | 'BARCODE'>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: VariantValues
  ): Promise<Variant | 'BARCODE'>
  /** Variantes activas de um produto (para o desactivar em cascata não; só consulta). */
  countActive(scope: TenantScope, productId: string): Promise<number>
}

export interface PriceStore {
  listLists(scope: TenantScope, filter: { organizationId?: string }): Promise<PriceList[]>
  findList(scope: TenantScope, id: string): Promise<PriceList | null>
  /** `null` se já existir uma tabela com este nome na organização. */
  insertList(scope: TenantScope, values: PriceListValues): Promise<PriceList | null>
  updateList(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: PriceListValues
  ): Promise<PriceList | 'NAME_TAKEN'>
  listItems(scope: TenantScope, priceListId: string): Promise<PriceItem[]>
  findItem(scope: TenantScope, id: string): Promise<PriceItem | null>
  /** `null` se o escalão já existir para a variante nesta tabela. */
  insertItem(
    scope: TenantScope,
    priceListId: string,
    values: PriceItemValues
  ): Promise<PriceItem | null>
  updateItem(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Pick<PriceItemValues, 'unitPrice' | 'maxDiscount'>
  ): Promise<PriceItem>
  deleteItem(scope: TenantScope, id: string): Promise<boolean>
  /** Os preços aplicáveis: organização, moeda, validade e escalão ≤ quantidade. */
  candidates(
    scope: TenantScope,
    query: {
      variantId: string
      organizationId: string
      currency: string
      date: string
      quantity: string
    }
  ): Promise<PriceCandidate[]>
}

/** Referências a outros módulos, vistas pelas suas APIs públicas. */
export interface References {
  unitExists(context: TenantContext, unitId: string): Promise<boolean>
  organizationExists(context: TenantContext, organizationId: string): Promise<boolean>
}

/** Há movimentos de stock deste produto? Registada pelo inventário; sem inventário, não há movimentos. */
export type MovementGuard = (scope: TenantScope, productId: string) => Promise<boolean>
