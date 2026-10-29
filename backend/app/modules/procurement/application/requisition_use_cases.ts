import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  isIsoDate,
  normalizeRequisitionLine,
  type Issue,
  type RequisitionLineInput,
  type RequisitionStatus,
} from '#modules/procurement/domain/procurement'
import {
  denied,
  failure,
  MAX_LINES,
  MAX_PAGE,
  procurementValidation,
  type Clock,
} from '#modules/procurement/application/errors'
import type {
  References,
  Requisition,
  RequisitionLine,
  RequisitionStore,
} from '#modules/procurement/application/ports'

export type RequisitionDetail = Requisition & { lines: RequisitionLine[] }

export interface RequisitionInput {
  organizationId?: string
  neededOn?: string | null
  notes?: string | null
  lines?: RequisitionLineInput[]
}

/**
 * Requisições (M06): o pedido interno de compra. Nasce em rascunho, é submetida (recebe número) e decidida por **outra
 * pessoa** (segregação de funções: quem pede não aprova). Aprovada, converte-se numa encomenda a fornecedor (ver
 * `PurchaseUseCases.convert`). Depois de submetida não se altera nem se apaga.
 */
export class RequisitionUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly requisitions: RequisitionStore,
    private readonly references: References,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: {
      status?: RequisitionStatus
      requestedByMembershipId?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(
      (scope) =>
        this.requisitions.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<RequisitionDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  async create(context: TenantContext, input: RequisitionInput): Promise<RequisitionDetail> {
    if (!context.membershipId) throw denied()
    const { neededOn, notes } = this.header(input)
    if (typeof input.organizationId !== 'string' || !input.organizationId) {
      throw failure('organizationId', 'REQUIRED', 'Indique a organização.')
    }
    if ((await this.references.organizationCurrency(context, input.organizationId)) === null) {
      throw failure('organizationId', 'UNKNOWN_ORGANIZATION', 'A organização não existe.')
    }
    if ((input.lines?.length ?? 0) > MAX_LINES) {
      throw failure('lines', 'TOO_MANY', `No máximo ${MAX_LINES} linhas.`)
    }
    return this.uow.run(async (scope) => {
      const created = await this.requisitions.insert(scope, {
        organizationId: input.organizationId as string,
        requestedByMembershipId: context.membershipId as string,
        neededOn,
        notes,
      })
      for (const [index, line] of (input.lines ?? []).entries()) {
        await this.addLineInScope(scope, context, created.id, line, `lines[${index}].`)
      }
      return this.detail(scope, created.id)
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; neededOn?: string | null; notes?: string | null }
  ): Promise<RequisitionDetail> {
    const { neededOn, notes } = this.header(input)
    return this.uow.run(async (scope) => {
      const current = await this.requireDraft(scope, id)
      await this.requisitions.updateHeader(scope, id, input.expectedVersion, {
        neededOn: input.neededOn === undefined ? current.neededOn : neededOn,
        notes: input.notes === undefined ? current.notes : notes,
      })
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      await this.requisitions.remove(scope, id)
    }, context)
  }

  addLine(
    context: TenantContext,
    id: string,
    input: RequisitionLineInput
  ): Promise<RequisitionDetail> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      const existing = await this.requisitions.listLines(scope, id)
      if (existing.length >= MAX_LINES) {
        throw failure('lines', 'TOO_MANY', `No máximo ${MAX_LINES} linhas.`)
      }
      await this.addLineInScope(scope, context, id, input, '')
      return this.detail(scope, id)
    }, context)
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<RequisitionDetail> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      if (!(await this.requisitions.findLine(scope, id, lineId))) throw ApiError.notFound()
      await this.requisitions.removeLine(scope, lineId)
      return this.detail(scope, id)
    }, context)
  }

  /** Submete o rascunho (número da sequência `PURCHASE_REQUISITION`). Idempotente. */
  submit(
    context: TenantContext,
    id: string
  ): Promise<{ requisition: RequisitionDetail; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const current = await this.requisitions.find(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.status !== 'DRAFT') {
        return { requisition: await this.detail(scope, id), idempotent: true }
      }
      const lines = await this.requisitions.listLines(scope, id)
      if (lines.length === 0) {
        throw ApiError.conflict('REQUISITION_EMPTY', 'Uma requisição sem linhas não se submete.')
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: current.organizationId,
        documentType: 'PURCHASE_REQUISITION',
        date: this.clock.now(),
      })
      await this.requisitions.submit(scope, id, number)
      return { requisition: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  /** Aprova ou rejeita uma requisição submetida; quem a pediu não a decide. Idempotente para a mesma decisão. */
  decide(
    context: TenantContext,
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    reason: unknown
  ): Promise<{ requisition: RequisitionDetail; idempotent: boolean }> {
    if (!context.membershipId) throw denied()
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (text.length > 300 || (decision === 'REJECTED' && !text)) {
      throw failure('reason', 'REASON_REQUIRED', 'Indique o motivo (até 300 caracteres).')
    }
    return this.uow.run(async (scope) => {
      const current = await this.requisitions.find(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (
        current.status === decision ||
        (decision === 'APPROVED' && current.status === 'CONVERTED')
      ) {
        return { requisition: await this.detail(scope, id), idempotent: true }
      }
      if (current.status !== 'SUBMITTED') {
        throw ApiError.conflict(
          'REQUISITION_NOT_SUBMITTED',
          'Só se decide uma requisição submetida e ainda sem decisão.'
        )
      }
      if (current.requestedByMembershipId === context.membershipId) {
        throw ApiError.conflict(
          'SEGREGATION_OF_DUTIES',
          'Quem pediu a requisição não a pode aprovar nem rejeitar.'
        )
      }
      await this.requisitions.decide(
        scope,
        id,
        decision,
        context.membershipId as string,
        text || null
      )
      return { requisition: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  // --- auxiliares ----------------------------------------------------------------------------

  private header(input: { neededOn?: string | null; notes?: string | null }) {
    const issues: Issue[] = []
    const neededOn = input.neededOn ?? null
    if (neededOn !== null && !isIsoDate(neededOn)) {
      issues.push({
        path: 'neededOn',
        code: 'INVALID_DATE',
        message: 'A data tem de ser AAAA-MM-DD.',
      })
    }
    const notes = typeof input.notes === 'string' ? input.notes.trim() || null : null
    if (notes && notes.length > 1000) {
      issues.push({
        path: 'notes',
        code: 'TOO_LONG',
        message: 'As notas têm no máximo 1000 caracteres.',
      })
    }
    if (issues.length > 0) throw procurementValidation(issues)
    return { neededOn, notes }
  }

  private async detail(scope: TenantScope, id: string): Promise<RequisitionDetail> {
    const requisition = await this.requisitions.find(scope, id)
    if (!requisition) throw ApiError.notFound()
    return { ...requisition, lines: await this.requisitions.listLines(scope, id) }
  }

  private async requireDraft(scope: TenantScope, id: string): Promise<Requisition> {
    const requisition = await this.requisitions.find(scope, id, true)
    if (!requisition) throw ApiError.notFound()
    if (requisition.status !== 'DRAFT') {
      throw ApiError.conflict(
        'REQUISITION_NOT_DRAFT',
        'Só uma requisição em rascunho se altera ou apaga.'
      )
    }
    return requisition
  }

  private async addLineInScope(
    scope: TenantScope,
    context: TenantContext,
    id: string,
    input: RequisitionLineInput,
    path: string
  ): Promise<void> {
    const issues: Issue[] = []
    const values = normalizeRequisitionLine(input, path, issues)
    if (!values) throw procurementValidation(issues)
    const variant = await this.references.variant(context, values.variantId)
    if (!variant || !variant.active) {
      throw failure(
        `${path}variantId`,
        'UNKNOWN_VARIANT',
        'A variante não existe ou está inactiva.'
      )
    }
    const created = await this.requisitions.insertLine(scope, id, {
      variantId: variant.id,
      description: variant.description,
      quantity: values.quantity,
    })
    if (!created) {
      throw ApiError.conflict(
        'REQUISITION_LINE_DUPLICATE',
        'Esta variante já está na requisição: altere a quantidade.'
      )
    }
  }
}
