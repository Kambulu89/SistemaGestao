import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  isIsoDate,
  purchaseBlocker,
  purchaseLineValues,
  sumLines,
  type Issue,
  type PurchaseLineInput,
  type PurchaseStatus,
} from '#modules/procurement/domain/procurement'
import {
  failure,
  MAX_LINES,
  MAX_PAGE,
  procurementValidation,
  type Clock,
} from '#modules/procurement/application/errors'
import type {
  PurchaseLine,
  PurchaseOrder,
  PurchaseStore,
  ReceiptStore,
  References,
  RequisitionStore,
  SupplierStore,
} from '#modules/procurement/application/ports'

export type PurchaseDetail = PurchaseOrder & {
  lines: (PurchaseLine & { receivedQty?: string })[]
}

export interface PurchaseInput {
  organizationId?: string
  supplierId?: string
  orderDate?: string
  notes?: string | null
  lines?: PurchaseLineInput[]
}

/**
 * Encomendas a fornecedor (M06): rascunho → encomendada (número, evento) → parcial/recebida pelas recepções, ou cancelada
 * (só enquanto nada foi recebido). Os custos e impostos das linhas fixam-se no rascunho com aritmética exacta; depois de
 * encomendada nada se altera. Confirmar não recebe: a entrada de stock é uma recepção.
 */
export class PurchaseUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly purchases: PurchaseStore,
    private readonly suppliers: SupplierStore,
    private readonly requisitions: RequisitionStore,
    private readonly receipts: ReceiptStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: {
      supplierId?: string
      status?: PurchaseStatus
      q?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(
      (scope) =>
        this.purchases.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<PurchaseDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  async create(context: TenantContext, input: PurchaseInput): Promise<PurchaseDetail> {
    const { orderDate, notes } = this.header(input)
    if (typeof input.supplierId !== 'string' || !input.supplierId) {
      throw failure('supplierId', 'REQUIRED', 'Indique o fornecedor.')
    }
    if ((input.lines?.length ?? 0) > MAX_LINES) {
      throw failure('lines', 'TOO_MANY', `No máximo ${MAX_LINES} linhas.`)
    }
    return this.uow.run(async (scope) => {
      const supplier = await this.suppliers.find(scope, input.supplierId as string)
      if (!supplier) throw failure('supplierId', 'UNKNOWN_SUPPLIER', 'O fornecedor não existe.')
      if (input.organizationId && input.organizationId !== supplier.organizationId) {
        throw failure(
          'organizationId',
          'ORGANIZATION_MISMATCH',
          'O fornecedor pertence a outra organização.'
        )
      }
      const blocker = purchaseBlocker(supplier.status)
      if (blocker) throw ApiError.conflict(blocker.code, blocker.message)
      const created = await this.purchases.insert(scope, {
        organizationId: supplier.organizationId,
        supplierId: supplier.id,
        requisitionId: null,
        orderDate: orderDate ?? this.today(),
        currency: supplier.currency,
        notes,
      })
      for (const [index, line] of (input.lines ?? []).entries()) {
        await this.addLineInScope(scope, context, created, line, `lines[${index}].`)
      }
      return this.retotal(scope, created.id)
    }, context)
  }

  /**
   * Converte uma requisição aprovada numa encomenda em rascunho. Os custos vêm do pedido (uma linha por linha da
   * requisição, com `unitCost`), porque a requisição não leva preços. Idempotente: converter outra vez devolve a encomenda.
   */
  convert(
    context: TenantContext,
    requisitionId: string,
    input: { supplierId?: string; lines?: PurchaseLineInput[] }
  ): Promise<{ order: PurchaseDetail; idempotent: boolean }> {
    if (typeof input.supplierId !== 'string' || !input.supplierId) {
      throw failure('supplierId', 'REQUIRED', 'Indique o fornecedor.')
    }
    return this.uow.run(async (scope) => {
      const requisition = await this.requisitions.find(scope, requisitionId, true)
      if (!requisition) throw ApiError.notFound()
      if (requisition.status === 'CONVERTED' && requisition.purchaseOrderId) {
        return { order: await this.detail(scope, requisition.purchaseOrderId), idempotent: true }
      }
      if (requisition.status !== 'APPROVED') {
        throw ApiError.conflict(
          'REQUISITION_NOT_APPROVED',
          'Só se converte uma requisição aprovada.'
        )
      }
      const supplier = await this.suppliers.find(scope, input.supplierId as string)
      if (!supplier) throw failure('supplierId', 'UNKNOWN_SUPPLIER', 'O fornecedor não existe.')
      if (supplier.organizationId !== requisition.organizationId) {
        throw failure(
          'supplierId',
          'ORGANIZATION_MISMATCH',
          'O fornecedor pertence a outra organização.'
        )
      }
      const blocker = purchaseBlocker(supplier.status)
      if (blocker) throw ApiError.conflict(blocker.code, blocker.message)
      const requested = await this.requisitions.listLines(scope, requisitionId)
      const costs = new Map((input.lines ?? []).map((l) => [l.variantId, l]))
      const problems: Issue[] = []
      for (const [index, line] of requested.entries()) {
        if (!costs.has(line.variantId)) {
          problems.push({
            path: `lines[${index}].unitCost`,
            code: 'COST_REQUIRED',
            message: `Indique o custo de «${line.description}».`,
          })
        }
      }
      if (problems.length > 0) throw procurementValidation(problems)
      const order = await this.purchases.insert(scope, {
        organizationId: requisition.organizationId,
        supplierId: supplier.id,
        requisitionId,
        orderDate: this.today(),
        currency: supplier.currency,
        notes: requisition.notes,
      })
      for (const [index, line] of requested.entries()) {
        const cost = costs.get(line.variantId) as PurchaseLineInput
        await this.addLineInScope(
          scope,
          context,
          order,
          {
            variantId: line.variantId,
            quantity: line.quantity,
            unitCost: cost.unitCost,
            taxRate: cost.taxRate,
          },
          `lines[${index}].`
        )
      }
      await this.retotal(scope, order.id)
      await this.requisitions.markConverted(scope, requisitionId, order.id)
      return { order: await this.detail(scope, order.id), idempotent: false }
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; orderDate?: string; notes?: string | null }
  ): Promise<PurchaseDetail> {
    const { orderDate, notes } = this.header(input)
    return this.uow.run(async (scope) => {
      const current = await this.requireDraft(scope, id)
      await this.purchases.updateHeader(scope, id, input.expectedVersion, {
        orderDate: orderDate ?? current.orderDate,
        notes: input.notes === undefined ? current.notes : notes,
      })
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const order = await this.requireDraft(scope, id)
      if (order.requisitionId) {
        throw ApiError.conflict(
          'PURCHASE_ORDER_FROM_REQUISITION',
          'Uma encomenda criada de uma requisição não se apaga.'
        )
      }
      await this.purchases.remove(scope, id)
    }, context)
  }

  addLine(context: TenantContext, id: string, input: PurchaseLineInput): Promise<PurchaseDetail> {
    return this.uow.run(async (scope) => {
      const order = await this.requireDraft(scope, id)
      const existing = await this.purchases.listLines(scope, id)
      if (existing.length >= MAX_LINES) {
        throw failure('lines', 'TOO_MANY', `No máximo ${MAX_LINES} linhas.`)
      }
      await this.addLineInScope(scope, context, order, input, '')
      return this.retotal(scope, id)
    }, context)
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<PurchaseDetail> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      if (!(await this.purchases.findLine(scope, id, lineId))) throw ApiError.notFound()
      await this.purchases.removeLine(scope, lineId)
      return this.retotal(scope, id)
    }, context)
  }

  /** Confirma a encomenda (número `PURCHASE_ORDER`, evento). Idempotente: confirmar outra vez devolve-a. */
  confirm(
    context: TenantContext,
    id: string
  ): Promise<{ order: PurchaseDetail; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const order = await this.purchases.find(scope, id, true)
      if (!order) throw ApiError.notFound()
      if (order.status === 'CANCELLED') {
        throw ApiError.conflict('PURCHASE_ORDER_CANCELLED', 'A encomenda está cancelada.')
      }
      if (order.status !== 'DRAFT') return { order: await this.detail(scope, id), idempotent: true }
      const lines = await this.purchases.listLines(scope, id)
      if (lines.length === 0) {
        throw ApiError.conflict('PURCHASE_ORDER_EMPTY', 'Uma encomenda sem linhas não se confirma.')
      }
      const supplier = await this.suppliers.find(scope, order.supplierId)
      const blocker = supplier ? purchaseBlocker(supplier.status) : null
      if (blocker) throw ApiError.conflict(blocker.code, blocker.message)
      const number = await this.references.issueNumber(scope, {
        organizationId: order.organizationId,
        documentType: 'PURCHASE_ORDER',
        date: this.clock.now(),
      })
      const confirmed = await this.purchases.confirm(scope, id, number)
      await this.outbox.append(scope, {
        aggregateType: 'purchase_order',
        aggregateId: id,
        aggregateVersion: confirmed.version,
        eventType: 'procurement.purchase_order.confirmed',
        payload: {
          purchaseOrderId: id,
          number,
          organizationId: order.organizationId,
          supplierId: order.supplierId,
          currency: order.currency,
          totals: confirmed.totals,
        },
        correlationId: context.correlationId,
      })
      return { order: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  /** Cancela uma encomenda confirmada, com motivo, enquanto nenhuma recepção lançada a tocou. Idempotente. */
  cancel(
    context: TenantContext,
    id: string,
    reason: unknown
  ): Promise<{ order: PurchaseDetail; idempotent: boolean }> {
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text || text.length > 300) {
      throw failure('reason', 'REASON_REQUIRED', 'Indique o motivo (até 300 caracteres).')
    }
    return this.uow.run(async (scope) => {
      await this.purchases.lock(scope, id)
      const order = await this.purchases.find(scope, id, true)
      if (!order) throw ApiError.notFound()
      if (order.status === 'CANCELLED')
        return { order: await this.detail(scope, id), idempotent: true }
      if (order.status === 'DRAFT') {
        throw ApiError.conflict(
          'PURCHASE_ORDER_NOT_CONFIRMED',
          'Um rascunho apaga-se; só se cancela uma encomenda confirmada.'
        )
      }
      const received = await this.receipts.receivedByLine(scope, id)
      if (order.status !== 'ORDERED' || received.size > 0) {
        throw ApiError.conflict(
          'PURCHASE_ORDER_HAS_RECEIPTS',
          'Uma encomenda já recebida (total ou parcialmente) não se cancela: reverta as recepções.'
        )
      }
      const cancelled = await this.purchases.cancel(scope, id, text)
      await this.outbox.append(scope, {
        aggregateType: 'purchase_order',
        aggregateId: id,
        aggregateVersion: cancelled.version,
        eventType: 'procurement.purchase_order.cancelled',
        payload: { purchaseOrderId: id, number: order.number, reason: text },
        correlationId: context.correlationId,
      })
      return { order: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  // --- auxiliares ----------------------------------------------------------------------------

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10)
  }

  private header(input: { orderDate?: string; notes?: string | null }) {
    const issues: Issue[] = []
    if (input.orderDate !== undefined && !isIsoDate(input.orderDate)) {
      issues.push({
        path: 'orderDate',
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
    return { orderDate: input.orderDate, notes }
  }

  private async detail(scope: TenantScope, id: string): Promise<PurchaseDetail> {
    const order = await this.purchases.find(scope, id)
    if (!order) throw ApiError.notFound()
    const lines = await this.purchases.listLines(scope, id)
    const received = await this.receipts.receivedByLine(scope, id)
    return {
      ...order,
      lines: lines.map((l) => ({ ...l, receivedQty: received.get(l.id) ?? '0.000000' })),
    }
  }

  private async requireDraft(scope: TenantScope, id: string): Promise<PurchaseOrder> {
    const order = await this.purchases.find(scope, id, true)
    if (!order) throw ApiError.notFound()
    if (order.status !== 'DRAFT') {
      throw ApiError.conflict(
        'PURCHASE_ORDER_NOT_DRAFT',
        'Só uma encomenda em rascunho se altera ou apaga.'
      )
    }
    return order
  }

  private async addLineInScope(
    scope: TenantScope,
    context: TenantContext,
    order: PurchaseOrder,
    input: PurchaseLineInput,
    path: string
  ): Promise<void> {
    const issues: Issue[] = []
    const mode = await this.references.roundingMode(context, order.organizationId)
    const values = purchaseLineValues(input, path, mode, issues)
    if (!values) throw procurementValidation(issues)
    const variant = await this.references.variant(context, values.variantId)
    if (!variant || !variant.active) {
      throw failure(
        `${path}variantId`,
        'UNKNOWN_VARIANT',
        'A variante não existe ou está inactiva.'
      )
    }
    await this.purchases.insertLine(scope, order.id, variant.description, values)
  }

  private async retotal(scope: TenantScope, id: string): Promise<PurchaseDetail> {
    const lines = await this.purchases.listLines(scope, id)
    await this.purchases.setTotals(scope, id, sumLines(lines))
    return this.detail(scope, id)
  }
}
