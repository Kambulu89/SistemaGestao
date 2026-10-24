import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  blockReasonIssue,
  normalizeCustomer,
  normalizeInteraction,
  normalizeSegment,
  saleBlocker,
  touchesCredit,
  type CustomerInput,
  type InteractionInput,
  type Issue,
  type SegmentInput,
} from '#modules/customers/domain/customers'
import type {
  Customer,
  CustomerFilter,
  CustomerStore,
  Interaction,
  InteractionStore,
  References,
  Segment,
  SegmentStore,
} from '#modules/customers/application/ports'

const validation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

const denied = () => new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')

const MAX_PAGE = 200

interface Clock {
  now(): Date
}

/** Segmentos de clientes. Nada se apaga: desactiva-se. */
export class SegmentUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly segments: SegmentStore
  ) {}

  list(context: TenantContext): Promise<Segment[]> {
    return this.uow.run((scope) => this.segments.list(scope), context)
  }

  async create(context: TenantContext, input: SegmentInput): Promise<Segment> {
    const issues: Issue[] = []
    const values = normalizeSegment(input, null, issues)
    if (!values) throw validation(issues)
    return this.uow.run(async (scope) => {
      const created = await this.segments.insert(scope, values)
      if (!created) {
        throw ApiError.conflict('SEGMENT_CODE_TAKEN', 'Já existe um segmento com este código.')
      }
      return created
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    input: SegmentInput & { expectedVersion: number }
  ): Promise<Segment> {
    return this.uow.run(async (scope) => {
      const current = await this.segments.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeSegment(input, current, issues)
      if (!values) throw validation(issues)
      return this.segments.update(scope, id, input.expectedVersion, values)
    }, context)
  }
}

/** Opções de quem executa: o que só a permissão de crédito autoriza. */
export interface Caller {
  canManageCredit: boolean
}

/** Clientes (M01): condições comerciais sobre uma Party, por organização. */
export class CustomerUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly customers: CustomerStore,
    private readonly segments: SegmentStore,
    private readonly references: References
  ) {}

  list(
    context: TenantContext,
    filter: Omit<CustomerFilter, 'limit' | 'offset'> & { limit?: number; offset?: number }
  ): Promise<{ items: Customer[]; total: number }> {
    return this.uow.run(
      (scope) =>
        this.customers.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<Customer> {
    return this.uow.run(async (scope) => {
      const customer = await this.customers.find(scope, id)
      if (!customer) throw ApiError.notFound()
      return customer
    }, context)
  }

  /** Chamada pelos documentos de venda (propostas, encomendas): bloqueado e inactivo não aceitam novas confirmações. */
  assertSaleAllowed(context: TenantContext, id: string): Promise<Customer> {
    return this.uow.run(async (scope) => {
      const customer = await this.customers.find(scope, id)
      if (!customer) throw ApiError.notFound()
      const blocker = saleBlocker(customer.status)
      if (blocker) throw ApiError.conflict(blocker.code, blocker.message)
      return customer
    }, context)
  }

  private async checkReferences(
    context: TenantContext,
    scope: Parameters<References['membershipActive']>[0],
    values: { segmentId: string | null; accountManagerMembershipId: string | null },
    issues: Issue[]
  ): Promise<void> {
    if (values.segmentId) {
      const segment = await this.segments.find(scope, values.segmentId)
      if (!segment || !segment.active) {
        issues.push({
          path: 'segmentId',
          code: 'UNKNOWN_SEGMENT',
          message: 'O segmento não existe ou está inactivo.',
        })
      }
    }
    const manager = values.accountManagerMembershipId
    if (manager && !(await this.references.membershipActive(scope, manager))) {
      issues.push({
        path: 'accountManagerMembershipId',
        code: 'UNKNOWN_MEMBER',
        message: 'O gestor de conta tem de ser um membro activo do tenant.',
      })
    }
    void context
  }

  async create(context: TenantContext, input: CustomerInput, caller: Caller): Promise<Customer> {
    if (touchesCredit(input) && !caller.canManageCredit) throw denied()
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    const currency = organizationId
      ? await this.references.organizationCurrency(context, organizationId)
      : null
    const issues: Issue[] = []
    if (organizationId && !currency) {
      issues.push({
        path: 'organizationId',
        code: 'UNKNOWN_ORGANIZATION',
        message: 'A organização não existe.',
      })
    }
    const values = normalizeCustomer(input, null, currency ?? 'AOA', issues)
    if (!values || issues.length > 0) throw validation(issues)
    if (values.status !== 'ACTIVE' && values.status !== 'INACTIVE') throw validation(issues)
    if (!(await this.references.partyExists(context, values.partyId))) {
      throw validation([
        { path: 'partyId', code: 'UNKNOWN_PARTY', message: 'A pessoa ou organização não existe.' },
      ])
    }
    return this.uow.run(async (scope) => {
      const refs: Issue[] = []
      await this.checkReferences(context, scope, values, refs)
      if (refs.length > 0) throw validation(refs)
      const created = await this.customers.insert(scope, values)
      if (created === 'CODE') {
        throw ApiError.conflict('CUSTOMER_CODE_TAKEN', 'Já existe um cliente com este código.')
      }
      if (created === 'PARTY') {
        throw ApiError.conflict(
          'CUSTOMER_EXISTS',
          'Esta pessoa ou organização já é cliente desta organização.'
        )
      }
      return created
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    input: CustomerInput & { expectedVersion: number },
    caller: Caller
  ): Promise<Customer> {
    if (touchesCredit(input) && !caller.canManageCredit) throw denied()
    for (const immutable of ['partyId', 'organizationId', 'code'] as const) {
      if (input[immutable] !== undefined) {
        throw validation([
          {
            path: immutable,
            code: 'IMMUTABLE',
            message: 'A pessoa, a organização e o código não mudam depois de criado.',
          },
        ])
      }
    }
    return this.uow.run(async (scope) => {
      const current = await this.customers.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeCustomer(input, current, current.currency, issues)
      if (!values) throw validation(issues)
      await this.checkReferences(context, scope, values, issues)
      if (issues.length > 0) throw validation(issues)
      return this.customers.update(scope, id, input.expectedVersion, values)
    }, context)
  }

  /** Bloquear exige motivo. Um cliente bloqueado continua a poder pagar e regularizar; só não recebe novas confirmações. */
  block(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; reason: string }
  ): Promise<Customer> {
    const issue = blockReasonIssue(input.reason)
    if (issue) throw validation([issue])
    return this.uow.run(async (scope) => {
      const current = await this.customers.find(scope, id)
      if (!current) throw ApiError.notFound()
      if (current.status === 'BLOCKED') {
        throw ApiError.conflict('ALREADY_BLOCKED', 'O cliente já está bloqueado.')
      }
      return this.customers.update(scope, id, input.expectedVersion, {
        ...current,
        status: 'BLOCKED',
        statusReason: input.reason.trim(),
      })
    }, context)
  }

  unblock(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number }
  ): Promise<Customer> {
    return this.uow.run(async (scope) => {
      const current = await this.customers.find(scope, id)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'BLOCKED') {
        throw ApiError.conflict('NOT_BLOCKED', 'O cliente não está bloqueado.')
      }
      return this.customers.update(scope, id, input.expectedVersion, {
        ...current,
        status: 'ACTIVE',
        statusReason: null,
      })
    }, context)
  }
}

/** Interacções comerciais com uma Party (existam ou não vendas). O responsável é quem as regista. */
export class InteractionUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly interactions: InteractionStore,
    private readonly references: References,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: {
      partyId?: string
      ownerMembershipId?: string
      followUpBefore?: string
      limit?: number
      offset?: number
    }
  ): Promise<{ items: Interaction[]; total: number }> {
    return this.uow.run(
      (scope) =>
        this.interactions.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<Interaction> {
    return this.uow.run(async (scope) => {
      const found = await this.interactions.find(scope, id)
      if (!found) throw ApiError.notFound()
      return found
    }, context)
  }

  async create(context: TenantContext, input: InteractionInput): Promise<Interaction> {
    if (!context.membershipId) throw denied()
    const issues: Issue[] = []
    const values = normalizeInteraction(input, null, context.membershipId, this.clock.now(), issues)
    if (!values) throw validation(issues)
    if (!(await this.references.partyExists(context, values.partyId))) {
      throw validation([
        { path: 'partyId', code: 'UNKNOWN_PARTY', message: 'A pessoa ou organização não existe.' },
      ])
    }
    return this.uow.run((scope) => this.interactions.insert(scope, values), context)
  }

  update(
    context: TenantContext,
    id: string,
    input: InteractionInput & { expectedVersion: number }
  ): Promise<Interaction> {
    if (input.partyId !== undefined) {
      throw validation([
        {
          path: 'partyId',
          code: 'IMMUTABLE',
          message: 'Uma interacção não muda de pessoa ou organização.',
        },
      ])
    }
    return this.uow.run(async (scope) => {
      const current = await this.interactions.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeInteraction(
        input,
        current,
        current.ownerMembershipId,
        this.clock.now(),
        issues
      )
      if (!values) throw validation(issues)
      return this.interactions.update(scope, id, input.expectedVersion, values)
    }, context)
  }
}
