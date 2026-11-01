import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { brandIssues, type BrandValues } from '#modules/catalog/domain/catalog'
import { catalogValidation } from '#modules/catalog/application/catalog_use_cases'

export interface Brand extends BrandValues {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface BrandStore {
  list(scope: TenantScope): Promise<Brand[]>
  find(scope: TenantScope, id: string): Promise<Brand | null>
  /** `null` se o código já existir no tenant. */
  insert(scope: TenantScope, values: BrandValues): Promise<Brand | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<BrandValues, 'code'>>
  ): Promise<Brand>
}

/** Marcas do catálogo: código único e imutável no tenant; sem eliminação (inactivar mantém o histórico dos produtos). */
export class BrandUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly brands: BrandStore
  ) {}

  list(context: TenantContext): Promise<Brand[]> {
    return this.uow.run((scope) => this.brands.list(scope), context)
  }

  create(
    context: TenantContext,
    input: {
      code: string
      name: string
      description?: string | null
      countryCode?: string | null
      active?: boolean
    }
  ): Promise<Brand> {
    const issues = brandIssues(input, true)
    if (issues.length > 0) throw catalogValidation(issues)
    return this.uow.run(async (scope) => {
      const created = await this.brands.insert(scope, {
        code: input.code.trim(),
        name: input.name.trim(),
        description: input.description?.trim() || null,
        countryCode: input.countryCode ?? null,
        active: input.active ?? true,
      })
      if (!created)
        throw ApiError.conflict('BRAND_CODE_TAKEN', 'Já existe uma marca com este código.')
      return created
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      name?: string
      description?: string | null
      countryCode?: string | null
      active?: boolean
    }
  ): Promise<Brand> {
    const issues = brandIssues(input, false)
    if (issues.length > 0) throw catalogValidation(issues)
    const { expectedVersion, ...patch } = input
    return this.uow.run(async (scope) => {
      if (!(await this.brands.find(scope, id))) throw ApiError.notFound('Marca não encontrada.')
      return this.brands.update(scope, id, expectedVersion, {
        ...patch,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      })
    }, context)
  }
}
