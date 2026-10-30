import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type {
  CategoryValues,
  PriceCandidate,
  PriceItemValues,
  PriceListValues,
  ProductType,
  ProductValues,
  TrackingMode,
  VariantValues,
} from '#modules/catalog/domain/catalog'
import type {
  Category,
  CategoryStore,
  PriceItem,
  PriceList,
  PriceStore,
  Product,
  ProductFilter,
  ProductStore,
  Variant,
  VariantStore,
} from '#modules/catalog/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const uniqueViolation = (error: unknown): string | null =>
  (error as { code?: string }).code === '23505'
    ? ((error as { constraint?: string }).constraint ?? '')
    : null

// --- categorias -------------------------------------------------------------------------------------

interface CategoryRow {
  id: string
  parent_id: string | null
  code: string
  name: string
  version: number
  created_at: Date
  updated_at: Date
}
const CATEGORY_COLUMNS = 'id, parent_id, code, name, version, created_at, updated_at'
const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  parentId: r.parent_id,
  code: r.code,
  name: r.name,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidCategoryStore implements CategoryStore {
  async list(scope: TenantScope) {
    const result = await trxOf(scope).rawQuery(
      `select ${CATEGORY_COLUMNS} from product_categories where tenant_id = ? order by code`,
      [tenantOf(scope)]
    )
    return (result.rows as CategoryRow[]).map(toCategory)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${CATEGORY_COLUMNS} from product_categories where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as CategoryRow[]
    return row ? toCategory(row) : null
  }

  async insert(scope: TenantScope, v: CategoryValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into product_categories (tenant_id, parent_id, code, name, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [tenantOf(scope), v.parentId as never, v.code, v.name, actorOf(scope), actorOf(scope)]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<CategoryValues, 'name' | 'parentId'>>
  ) {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.parentId !== undefined) {
      sets.push('parent_id = ?')
      params.push(patch.parentId)
    }
    const result = await trxOf(scope).rawQuery(
      `update product_categories
          set ${sets.join(', ')}${sets.length ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [...params, actorOf(scope), tenantOf(scope), id, expectedVersion] as never[]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }
}

// --- produtos ---------------------------------------------------------------------------------------

interface ProductRow {
  id: string
  code: string
  name: string
  description: string | null
  type: ProductType
  category_id: string | null
  base_unit_id: string
  track_stock: boolean
  tracking_mode: TrackingMode
  active: boolean
  tax_category: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const PRODUCT_COLUMNS = `id, code, name, description, type, category_id, base_unit_id, track_stock, tracking_mode,
  active, tax_category, version, created_at, updated_at`
const toProduct = (r: ProductRow): Product => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  type: r.type,
  categoryId: r.category_id,
  baseUnitId: r.base_unit_id,
  trackStock: r.track_stock,
  trackingMode: r.tracking_mode,
  active: r.active,
  taxCategory: r.tax_category,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

export class LucidProductStore implements ProductStore {
  async list(scope: TenantScope, filter: ProductFilter) {
    const where = ['p.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.type) {
      where.push('p.type = ?')
      params.push(filter.type)
    }
    if (filter.categoryId) {
      where.push('p.category_id = ?')
      params.push(filter.categoryId)
    }
    if (filter.active !== undefined) {
      where.push('p.active = ?')
      params.push(filter.active)
    }
    if (filter.q) {
      const like = `%${escapeLike(filter.q.trim())}%`
      where.push(`(p.code ilike ? or p.name ilike ? or exists (
        select 1 from product_variants v
         where v.tenant_id = p.tenant_id and v.product_id = p.id and (v.sku ilike ? or v.barcode ilike ?)))`)
      params.push(like, like, like, like)
    }
    const total = await trxOf(scope).rawQuery(
      `select count(*)::int as n from products p where ${where.join(' and ')}`,
      params as never[]
    )
    const rows = await trxOf(scope).rawQuery(
      `select ${PRODUCT_COLUMNS.replaceAll('\n', ' ')
        .split(',')
        .map((c) => `p.${c.trim()}`)
        .join(', ')}
         from products p where ${where.join(' and ')} order by p.name, p.id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    return {
      items: (rows.rows as ProductRow[]).map(toProduct),
      total: (total.rows as { n: number }[])[0]?.n ?? 0,
    }
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${PRODUCT_COLUMNS} from products where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as ProductRow[]
    return row ? toProduct(row) : null
  }

  async insert(scope: TenantScope, v: ProductValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into products
         (tenant_id, code, name, description, type, category_id, base_unit_id, track_stock, tracking_mode, active,
          tax_category, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing returning id`,
      [
        tenantOf(scope),
        v.code,
        v.name,
        v.description as never,
        v.type,
        v.categoryId as never,
        v.baseUnitId,
        v.trackStock,
        v.trackingMode,
        v.active,
        v.taxCategory as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: ProductValues) {
    const result = await trxOf(scope).rawQuery(
      `update products
          set name = ?, description = ?, type = ?, category_id = ?, base_unit_id = ?, track_stock = ?,
              tracking_mode = ?, active = ?, tax_category = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.name,
        v.description as never,
        v.type,
        v.categoryId as never,
        v.baseUnitId,
        v.trackStock,
        v.trackingMode,
        v.active,
        v.taxCategory as never,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }
}

// --- variantes --------------------------------------------------------------------------------------

interface VariantRow {
  id: string
  product_id: string
  sku: string
  barcode: string | null
  attributes: VariantValues['attributes']
  active: boolean
  is_default: boolean
  version: number
  created_at: Date
  updated_at: Date
}
const VARIANT_COLUMNS =
  'id, product_id, sku, barcode, attributes, active, is_default, version, created_at, updated_at'
const toVariant = (r: VariantRow): Variant => ({
  id: r.id,
  productId: r.product_id,
  sku: r.sku,
  barcode: r.barcode,
  attributes: r.attributes,
  active: r.active,
  isDefault: r.is_default,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidVariantStore implements VariantStore {
  async listByProduct(scope: TenantScope, productId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${VARIANT_COLUMNS} from product_variants where tenant_id = ? and product_id = ?
        order by is_default desc, sku`,
      [tenantOf(scope), productId]
    )
    return (result.rows as VariantRow[]).map(toVariant)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${VARIANT_COLUMNS} from product_variants where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as VariantRow[]
    return row ? toVariant(row) : null
  }

  async insert(scope: TenantScope, productId: string, v: VariantValues, isDefault: boolean) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into product_variants
           (tenant_id, product_id, sku, barcode, attributes, active, is_default, created_by_membership_id,
            updated_by_membership_id)
         values (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?) returning ${VARIANT_COLUMNS}`,
        [
          tenantOf(scope),
          productId,
          v.sku,
          v.barcode as never,
          JSON.stringify(v.attributes),
          v.active,
          isDefault,
          actorOf(scope),
          actorOf(scope),
        ]
      )
      return toVariant((result.rows as VariantRow[])[0] as VariantRow)
    } catch (error) {
      const constraint = uniqueViolation(error)
      if (constraint === 'product_variants_sku_unique') return 'SKU' as const
      if (constraint === 'product_variants_barcode_unique') return 'BARCODE' as const
      throw error
    }
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: VariantValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `update product_variants
            set barcode = ?, attributes = ?::jsonb, active = ?, updated_at = now(),
                updated_by_membership_id = ?, version = version + 1
          where tenant_id = ? and id = ? and version = ? returning id`,
        [
          v.barcode as never,
          JSON.stringify(v.attributes),
          v.active,
          actorOf(scope),
          tenantOf(scope),
          id,
          expectedVersion,
        ]
      )
      const row = await this.find(scope, id)
      if (!row) throw ApiError.notFound()
      if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
      return row
    } catch (error) {
      if (uniqueViolation(error) === 'product_variants_barcode_unique') return 'BARCODE' as const
      throw error
    }
  }

  async countActive(scope: TenantScope, productId: string) {
    const result = await trxOf(scope).rawQuery(
      `select count(*)::int as n from product_variants where tenant_id = ? and product_id = ? and active`,
      [tenantOf(scope), productId]
    )
    return (result.rows as { n: number }[])[0]?.n ?? 0
  }
}

// --- tabelas de preços ------------------------------------------------------------------------------

interface PriceListRow {
  id: string
  organization_id: string
  name: string
  currency: string
  valid_from: string
  valid_to: string | null
  tax_inclusive: boolean
  priority: number
  version: number
  created_at: Date
  updated_at: Date
}
const LIST_COLUMNS = `id, organization_id, name, currency, valid_from::text as valid_from, valid_to::text as valid_to,
  tax_inclusive, priority, version, created_at, updated_at`
const toList = (r: PriceListRow): PriceList => ({
  id: r.id,
  organizationId: r.organization_id,
  name: r.name,
  currency: r.currency,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  taxInclusive: r.tax_inclusive,
  priority: r.priority,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface ItemRow {
  id: string
  price_list_id: string
  variant_id: string
  sku: string
  min_quantity: string
  unit_price: string
  max_discount: string
  version: number
  created_at: Date
  updated_at: Date
}
const ITEM_SELECT = `select i.id, i.price_list_id, i.variant_id, v.sku, i.min_quantity::text as min_quantity,
  i.unit_price::text as unit_price, i.max_discount::text as max_discount, i.version, i.created_at, i.updated_at
  from price_list_items i join product_variants v on v.tenant_id = i.tenant_id and v.id = i.variant_id`
const toItem = (r: ItemRow): PriceItem => ({
  id: r.id,
  priceListId: r.price_list_id,
  variantId: r.variant_id,
  sku: r.sku,
  minQuantity: r.min_quantity,
  unitPrice: r.unit_price,
  maxDiscount: r.max_discount,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidPriceStore implements PriceStore {
  async listLists(scope: TenantScope, filter: { organizationId?: string }) {
    const result = await trxOf(scope).rawQuery(
      `select ${LIST_COLUMNS} from price_lists where tenant_id = ?
         ${filter.organizationId ? 'and organization_id = ?' : ''}
        order by priority desc, name`,
      (filter.organizationId
        ? [tenantOf(scope), filter.organizationId]
        : [tenantOf(scope)]) as never[]
    )
    return (result.rows as PriceListRow[]).map(toList)
  }

  async findList(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${LIST_COLUMNS} from price_lists where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as PriceListRow[]
    return row ? toList(row) : null
  }

  async insertList(scope: TenantScope, v: PriceListValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into price_lists
         (tenant_id, organization_id, name, currency, valid_from, valid_to, tax_inclusive, priority,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.name,
        v.currency,
        v.validFrom,
        v.validTo as never,
        v.taxInclusive,
        v.priority,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.findList(scope, created.id) : null
  }

  async updateList(scope: TenantScope, id: string, expectedVersion: number, v: PriceListValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `update price_lists
            set name = ?, valid_from = ?, valid_to = ?, tax_inclusive = ?, priority = ?, updated_at = now(),
                updated_by_membership_id = ?, version = version + 1
          where tenant_id = ? and id = ? and version = ? returning id`,
        [
          v.name,
          v.validFrom,
          v.validTo as never,
          v.taxInclusive,
          v.priority,
          actorOf(scope),
          tenantOf(scope),
          id,
          expectedVersion,
        ]
      )
      const row = await this.findList(scope, id)
      if (!row) throw ApiError.notFound()
      if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
      return row
    } catch (error) {
      if (uniqueViolation(error) === 'price_lists_name_unique') return 'NAME_TAKEN' as const
      throw error
    }
  }

  async listItems(scope: TenantScope, priceListId: string) {
    const result = await trxOf(scope).rawQuery(
      `${ITEM_SELECT} where i.tenant_id = ? and i.price_list_id = ? order by v.sku, i.min_quantity`,
      [tenantOf(scope), priceListId]
    )
    return (result.rows as ItemRow[]).map(toItem)
  }

  async findItem(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `${ITEM_SELECT} where i.tenant_id = ? and i.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as ItemRow[]
    return row ? toItem(row) : null
  }

  async insertItem(scope: TenantScope, priceListId: string, v: PriceItemValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into price_list_items
         (tenant_id, price_list_id, variant_id, min_quantity, unit_price, max_discount,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [
        tenantOf(scope),
        priceListId,
        v.variantId,
        v.minQuantity,
        v.unitPrice,
        v.maxDiscount,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.findItem(scope, created.id) : null
  }

  async updateItem(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: Pick<PriceItemValues, 'unitPrice' | 'maxDiscount'>
  ) {
    const result = await trxOf(scope).rawQuery(
      `update price_list_items
          set unit_price = ?, max_discount = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [v.unitPrice, v.maxDiscount, actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    const row = await this.findItem(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }

  async deleteItem(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `delete from price_list_items where tenant_id = ? and id = ? returning id`,
      [tenantOf(scope), id]
    )
    return result.rows.length > 0
  }

  async candidates(
    scope: TenantScope,
    q: {
      variantId: string
      organizationId: string
      currency: string
      date: string
      quantity: string
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `select l.id as price_list_id, l.name as price_list_name, l.priority, l.tax_inclusive, l.currency,
              l.valid_from::text as valid_from, l.valid_to::text as valid_to,
              i.min_quantity::text as min_quantity, i.unit_price::text as unit_price,
              i.max_discount::text as max_discount
         from price_lists l
         join price_list_items i on i.tenant_id = l.tenant_id and i.price_list_id = l.id
        where l.tenant_id = ? and l.organization_id = ? and l.currency = ?
          and l.valid_from <= ?::date and (l.valid_to is null or l.valid_to >= ?::date)
          and i.variant_id = ? and i.min_quantity <= ?::numeric`,
      [tenantOf(scope), q.organizationId, q.currency, q.date, q.date, q.variantId, q.quantity]
    )
    return (
      result.rows as {
        price_list_id: string
        price_list_name: string
        priority: number
        tax_inclusive: boolean
        currency: string
        valid_from: string
        valid_to: string | null
        min_quantity: string
        unit_price: string
        max_discount: string
      }[]
    ).map((r): PriceCandidate => ({
      priceListId: r.price_list_id,
      priceListName: r.price_list_name,
      priority: r.priority,
      taxInclusive: r.tax_inclusive,
      currency: r.currency,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      minQuantity: r.min_quantity,
      unitPrice: r.unit_price,
      maxDiscount: r.max_discount,
    }))
  }
}
