import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  approvalTransition,
  normalizeSupplier,
  normalizeSupplierCategory,
  type ApprovalAction,
  type ApprovalStatus,
  type Issue,
  type SupplierInput,
  type SupplierStatus,
  type SupplierValues,
} from '#modules/procurement/domain/procurement'
import {
  type Clock,
  denied,
  MAX_PAGE,
  procurementValidation,
} from '#modules/procurement/application/errors'
import type {
  References,
  Supplier,
  SupplierApprovalEvent,
  SupplierCategory,
  SupplierCategoryStore,
  SupplierStore,
} from '#modules/procurement/application/ports'

/**
 * Fornecedores (M06): as condições de compra sobre uma Party, por organização. Nome, NIF e contactos continuam a ser da
 * Party. Um fornecedor bloqueado ou inactivo, com homologação rejeitada, suspensa ou caducada, ou crítico sem homologação
 * em vigor, não recebe novas encomendas; as já feitas continuam a receber-se.
 *
 * A homologação só muda por acções explícitas (submeter, aprovar, aprovar com condições, rejeitar, suspender), cada uma
 * com um evento no histórico só-de-acrescentar e no outbox. Quem pede a análise não homologa.
 */
export class SupplierUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly suppliers: SupplierStore,
    private readonly categories: SupplierCategoryStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: {
      q?: string
      status?: SupplierStatus
      organizationId?: string
      categoryId?: string
      approvalStatus?: ApprovalStatus
      critical?: boolean
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
    if (!values || issues.length > 0) throw procurementValidation(issues)
    if (!(await this.references.partyExists(context, values.partyId))) {
      throw procurementValidation([
        { path: 'partyId', code: 'UNKNOWN_PARTY', message: 'A pessoa ou organização não existe.' },
      ])
    }
    const created = await this.uow.run(async (scope) => {
      await this.ensureCategory(scope, values, null)
      return this.suppliers.insert(scope, values)
    }, context)
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
      await this.ensureCategory(scope, values, current.categoryId)
      return this.suppliers.update(scope, id, input.expectedVersion, values)
    }, context)
  }

  /** Muda a homologação; `SUBMIT` exige `supplier.manage` e as decisões `supplier.approve` (verificado nas rotas). */
  changeApproval(
    context: TenantContext,
    id: string,
    action: ApprovalAction,
    input: { expectedVersion: number; reason?: unknown; conditions?: unknown; validUntil?: unknown }
  ): Promise<Supplier> {
    if (!context.membershipId) throw denied()
    const actor = context.membershipId
    return this.uow.run(async (scope) => {
      const current = await this.suppliers.find(scope, id)
      if (!current) throw ApiError.notFound()
      if (current.version !== input.expectedVersion) {
        throw ApiError.versionConflict(current.version)
      }
      const outcome = approvalTransition(current, action, input, actor, this.today())
      if (!outcome.ok) {
        if (outcome.kind === 'invalid') throw procurementValidation(outcome.issues)
        throw ApiError.conflict(outcome.code, outcome.message)
      }
      const changed = await this.suppliers.changeApproval(
        scope,
        id,
        input.expectedVersion,
        outcome.change
      )
      await this.outbox.append(scope, {
        aggregateType: 'supplier',
        aggregateId: id,
        aggregateVersion: changed.version,
        eventType: 'procurement.supplier.approval_changed',
        payload: {
          supplierId: id,
          organizationId: changed.organizationId,
          action,
          fromStatus: outcome.change.from,
          toStatus: outcome.change.to,
          validUntil: outcome.change.validUntil,
        },
        correlationId: context.correlationId,
      })
      return changed
    }, context)
  }

  approvalHistory(context: TenantContext, id: string): Promise<SupplierApprovalEvent[]> {
    return this.uow.run(async (scope) => {
      if (!(await this.suppliers.find(scope, id))) throw ApiError.notFound()
      return this.suppliers.approvalEvents(scope, id)
    }, context)
  }

  // --- categorias --------------------------------------------------------------------------------

  listCategories(context: TenantContext, filter: { q?: string; active?: boolean }) {
    return this.uow.run((scope) => this.categories.list(scope, filter), context)
  }

  getCategory(context: TenantContext, id: string): Promise<SupplierCategory> {
    return this.uow.run(async (scope) => {
      const category = await this.categories.find(scope, id)
      if (!category) throw ApiError.notFound()
      return category
    }, context)
  }

  async createCategory(
    context: TenantContext,
    input: { code?: unknown; name?: unknown; description?: unknown; active?: unknown }
  ): Promise<SupplierCategory> {
    const issues: Issue[] = []
    const values = normalizeSupplierCategory(input, null, issues)
    if (!values) throw procurementValidation(issues)
    const created = await this.uow.run((scope) => this.categories.insert(scope, values), context)
    if (created === 'CODE') {
      throw ApiError.conflict(
        'SUPPLIER_CATEGORY_CODE_EXISTS',
        'Já existe uma categoria com este código.'
      )
    }
    return created
  }

  updateCategory(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      code?: unknown
      name?: unknown
      description?: unknown
      active?: unknown
    }
  ): Promise<SupplierCategory> {
    return this.uow.run(async (scope) => {
      const current = await this.categories.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeSupplierCategory(input, current, issues)
      if (!values) throw procurementValidation(issues)
      return this.categories.update(scope, id, input.expectedVersion, values)
    }, context)
  }

  // --- auxiliares --------------------------------------------------------------------------------

  /** A categoria tem de existir neste tenant; uma inactiva só se mantém, não se atribui de novo. */
  private async ensureCategory(
    scope: TenantScope,
    values: SupplierValues,
    previous: string | null
  ): Promise<void> {
    if (!values.categoryId || values.categoryId === previous) return
    const category = await this.categories.find(scope, values.categoryId)
    if (!category || !category.active) {
      throw procurementValidation([
        {
          path: 'categoryId',
          code: 'UNKNOWN_CATEGORY',
          message: 'A categoria não existe ou está inactiva.',
        },
      ])
    }
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10)
  }
}
