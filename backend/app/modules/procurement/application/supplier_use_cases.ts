import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  normalizeSupplier,
  type Issue,
  type SupplierInput,
  type SupplierStatus,
} from '#modules/procurement/domain/procurement'
import { MAX_PAGE, procurementValidation } from '#modules/procurement/application/errors'
import type { References, Supplier, SupplierStore } from '#modules/procurement/application/ports'

/**
 * Fornecedores (M06): as condições de compra sobre uma Party, por organização. Nome, NIF e contactos continuam a ser da
 * Party. Um fornecedor bloqueado ou inactivo não recebe novas encomendas; as já feitas continuam a receber-se.
 */
export class SupplierUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly suppliers: SupplierStore,
    private readonly references: References
  ) {}

  list(
    context: TenantContext,
    filter: {
      q?: string
      status?: SupplierStatus
      organizationId?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(
      (scope) =>
        this.suppliers.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<Supplier> {
    return this.uow.run(async (scope) => {
      const supplier = await this.suppliers.find(scope, id)
      if (!supplier) throw ApiError.notFound()
      return supplier
    }, context)
  }

  async create(context: TenantContext, input: SupplierInput): Promise<Supplier> {
    const issues: Issue[] = []
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    const currency = organizationId
      ? await this.references.organizationCurrency(context, organizationId)
      : null
    if (organizationId && currency === null) {
      issues.push({
        path: 'organizationId',
        code: 'UNKNOWN_ORGANIZATION',
        message: 'A organização não existe.',
      })
    }
    const values = normalizeSupplier(input, null, currency ?? 'AOA', issues)
    if (!values) throw procurementValidation(issues)
    if (!(await this.references.partyExists(context, values.partyId))) {
      throw procurementValidation([
        { path: 'partyId', code: 'UNKNOWN_PARTY', message: 'A pessoa ou organização não existe.' },
      ])
    }
    const created = await this.uow.run((scope) => this.suppliers.insert(scope, values), context)
    if (created === 'CODE') {
      throw ApiError.conflict('SUPPLIER_CODE_EXISTS', 'Já existe um fornecedor com este código.')
    }
    if (created === 'PARTY') {
      throw ApiError.conflict(
        'SUPPLIER_EXISTS',
        'Esta pessoa ou organização já é fornecedora desta organização.'
      )
    }
    return created
  }

  update(
    context: TenantContext,
    id: string,
    input: SupplierInput & { expectedVersion: number }
  ): Promise<Supplier> {
    return this.uow.run(async (scope) => {
      const current = await this.suppliers.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeSupplier(input, current, current.currency, issues)
      if (!values) throw procurementValidation(issues)
      return this.suppliers.update(scope, id, input.expectedVersion, values)
    }, context)
  }
}
