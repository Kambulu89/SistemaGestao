import {
  LucidTenantScope,
  TenantRepository,
  type TenantRow,
  type TenantScope,
} from '#core/tenancy/index'
import type { BrandValues } from '#modules/catalog/domain/catalog'
import type { Brand, BrandStore } from '#modules/catalog/application/brand_use_cases'

interface BrandRow extends TenantRow {
  code: string
  name: string
  description: string | null
  country_code: string | null
  active: boolean
}

class Brands extends TenantRepository<BrandRow> {
  protected readonly table = 'product_brands'
}

const toBrand = (r: BrandRow): Brand => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  countryCode: r.country_code,
  active: r.active,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidBrandStore implements BrandStore {
  private readonly brands = new Brands()

  async list(scope: TenantScope) {
    const { trx, context } = scope as LucidTenantScope
    const rows = await trx
      .from('product_brands')
      .where('tenant_id', context.tenantId)
      .orderBy('code')
      .limit(500)
    return (rows as BrandRow[]).map(toBrand)
  }

  async find(scope: TenantScope, id: string) {
    const row = await this.brands.findById(scope, id)
    return row ? toBrand(row) : null
  }

  async insert(scope: TenantScope, values: BrandValues) {
    try {
      return toBrand(
        await this.brands.insert(scope, {
          code: values.code,
          name: values.name,
          description: values.description,
          country_code: values.countryCode,
          active: values.active,
        })
      )
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return null
      throw error
    }
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<BrandValues, 'code'>>
  ) {
    const changes: Partial<BrandRow> = {}
    if (patch.name !== undefined) changes.name = patch.name
    if (patch.description !== undefined) changes.description = patch.description
    if (patch.countryCode !== undefined) changes.country_code = patch.countryCode
    if (patch.active !== undefined) changes.active = patch.active
    return toBrand(await this.brands.update(scope, id, expectedVersion, changes as never))
  }
}
