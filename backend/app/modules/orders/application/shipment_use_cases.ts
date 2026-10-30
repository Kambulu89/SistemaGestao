import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { toScaled } from '#modules/orders/domain/money'
import {
  canShip,
  fits,
  normalizeShipmentLine,
  quantityText,
  remaining,
  statusAfterShipping,
  type Balance,
  type ShipmentLineInput,
  type ShipmentStatus,
} from '#modules/orders/domain/shipments'
import { decimalPlaces } from '#modules/orders/domain/money'
import type { Issue } from '#modules/orders/domain/sales'
import type {
  Line,
  LineStore,
  Order,
  OrderStore,
  References,
  Shipment,
  ShipmentLine,
  ShipmentStore,
} from '#modules/orders/application/ports'
import {
  runPostedEffects,
  runReversedEffects,
  type ShipmentLineRef,
} from '#modules/orders/application/registry'
import { salesValidation } from '#modules/orders/application/line_engine'

const MAX_PAGE = 200

interface Clock {
  now(): Date
}

export type ShipmentDetail = Shipment & { lines: ShipmentLine[] }

/**
 * Expedições (M04): rascunho → lançada → (revertida). Lançar entrega a encomenda (parcial ou totalmente) e dispara os
 * efeitos registados (a baixa de stock, que consome as reservas) **na mesma transacção**; reverter desfá-los com
 * movimentos opostos. O saldo de cada linha verifica-se sob bloqueio da encomenda, por isso duas expedições concorrentes
 * nunca entregam mais do que foi encomendado.
 */
export class ShipmentUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly shipments: ShipmentStore,
    private readonly orders: OrderStore,
    private readonly orderLines: LineStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: { orderId?: string; status?: ShipmentStatus; limit?: number; offset?: number }
  ) {
    return this.uow.run(
      (scope) =>
        this.shipments.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<ShipmentDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  async create(
    context: TenantContext,
    input: { orderId: string; notes?: string | null; lines?: ShipmentLineInput[] }
  ): Promise<ShipmentDetail> {
    const notes = typeof input.notes === 'string' ? input.notes.trim() || null : null
    if (notes && notes.length > 1000) {
      throw salesValidation([
        { path: 'notes', code: 'TOO_LONG', message: 'As notas têm no máximo 1000 caracteres.' },
      ])
    }
    return this.uow.run(async (scope) => {
      const order = await this.orders.find(scope, input.orderId)
      if (!order) throw ApiError.notFound()
      this.assertShippable(order)
      const created = await this.shipments.insert(scope, {
        organizationId: order.organizationId,
        orderId: order.id,
        notes,
      })
      const lines = input.lines ?? []
      if (lines.length > 100) {
        throw salesValidation([
          { path: 'lines', code: 'TOO_MANY', message: 'No máximo 100 linhas por expedição.' },
        ])
      }
      for (const [index, raw] of lines.entries()) {
        await this.addLineInScope(scope, created, order, raw, `lines[${index}].`)
      }
      return this.detail(scope, created.id)
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; notes?: string | null }
  ): Promise<ShipmentDetail> {
    return this.uow.run(async (scope) => {
      const shipment = await this.requireDraft(scope, id)
      if (input.notes !== undefined) {
        const notes = typeof input.notes === 'string' ? input.notes.trim() || null : null
        if (notes && notes.length > 1000) {
          throw salesValidation([
            { path: 'notes', code: 'TOO_LONG', message: 'As notas têm no máximo 1000 caracteres.' },
          ])
        }
        await this.shipments.updateNotes(scope, id, input.expectedVersion, notes)
      } else if (input.expectedVersion !== shipment.version) {
        throw ApiError.versionConflict(shipment.version)
      }
      return this.detail(scope, id)
    }, context)
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    await this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      await this.shipments.remove(scope, id)
    }, context)
  }

  async addLine(
    context: TenantContext,
    id: string,
    input: ShipmentLineInput
  ): Promise<ShipmentDetail> {
    return this.uow.run(async (scope) => {
      const shipment = await this.requireDraft(scope, id)
      const order = (await this.orders.find(scope, shipment.orderId)) as Order
      this.assertShippable(order)
      await this.addLineInScope(scope, shipment, order, input, '')
      return this.detail(scope, id)
    }, context)
  }

  async updateLine(
    context: TenantContext,
    id: string,
    lineId: string,
    input: { quantity?: unknown }
  ): Promise<ShipmentDetail> {
    return this.uow.run(async (scope) => {
      const shipment = await this.requireDraft(scope, id)
      const line = await this.shipments.findLine(scope, id, lineId)
      if (!line) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeShipmentLine(
        { orderLineId: line.orderLineId, quantity: input.quantity },
        '',
        issues
      )
      if (!values) throw salesValidation(issues)
      const order = (await this.orders.find(scope, shipment.orderId)) as Order
      this.assertShippable(order)
      await this.checkBalance(scope, order, line.orderLineId, values.quantity, 'quantity')
      await this.shipments.updateLine(scope, lineId, values.quantity)
      return this.detail(scope, id)
    }, context)
  }

  async removeLine(context: TenantContext, id: string, lineId: string): Promise<ShipmentDetail> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      if (!(await this.shipments.findLine(scope, id, lineId))) throw ApiError.notFound()
      await this.shipments.removeLine(scope, lineId)
      return this.detail(scope, id)
    }, context)
  }

  /**
   * Lança a expedição: confere o saldo de cada linha sob bloqueio da encomenda, emite o número, baixa o stock (efeitos
   * registados) e actualiza o estado da encomenda. Idempotente: lançar outra vez devolve-a, sem novo número nem baixa.
   */
  post(
    context: TenantContext,
    id: string
  ): Promise<{ shipment: ShipmentDetail; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const shipment = await this.shipments.find(scope, id, true)
      if (!shipment) throw ApiError.notFound()
      if (shipment.status === 'POSTED') {
        return { shipment: await this.detail(scope, id), idempotent: true }
      }
      if (shipment.status === 'REVERSED') {
        throw ApiError.conflict('SHIPMENT_REVERSED', 'A expedição já foi revertida.')
      }
      const order = (await this.orders.find(scope, shipment.orderId, true)) as Order
      this.assertShippable(order)
      const lines = await this.shipments.listLines(scope, id)
      if (lines.length === 0) {
        throw ApiError.conflict('SHIPMENT_EMPTY', 'Uma expedição sem linhas não se lança.')
      }
      const orderLines = await this.orderLines.list(scope, { orderId: order.id })
      const shipped = await this.shipments.shippedByLine(scope, order.id)
      const problems: Issue[] = []
      for (const [index, line] of lines.entries()) {
        const balance = this.balanceOf(orderLines, shipped, line.orderLineId)
        if (!balance || !fits(balance, line.quantity)) {
          problems.push({
            path: `lines[${index}].quantity`,
            code: 'EXCEEDS_BALANCE',
            message: `Só falta expedir ${quantityText(balance ? remaining(balance) : 0n)}.`,
          })
        }
      }
      if (problems.length > 0) {
        throw new ApiError(
          409,
          'SHIPMENT_NOT_POSTABLE',
          'A expedição não pode ser lançada.',
          problems
        )
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: order.organizationId,
        documentType: 'SHIPMENT',
        date: this.clock.now(),
      })
      const posted = await this.shipments.post(scope, id, number)
      const refs = this.refsOf(lines, orderLines)
      // A baixa de stock (e afins): um erro aqui anula o lançamento por inteiro.
      await runPostedEffects(scope, posted, order, refs)
      const after = await this.refreshOrder(scope, order, orderLines)
      await this.outbox.append(scope, {
        aggregateType: 'shipment',
        aggregateId: id,
        aggregateVersion: posted.version,
        eventType: 'sales.shipment.posted',
        payload: {
          shipmentId: id,
          number,
          orderId: order.id,
          orderStatus: after.status,
          organizationId: order.organizationId,
          lines: lines.map((l) => ({
            lineId: l.id,
            orderLineId: l.orderLineId,
            quantity: l.quantity,
          })),
        },
        correlationId: context.correlationId,
      })
      return { shipment: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  /** Reverte uma expedição lançada (com motivo): repõe o stock com movimentos opostos e reabre o saldo da encomenda. */
  reverse(
    context: TenantContext,
    id: string,
    reason: string
  ): Promise<{ shipment: ShipmentDetail; idempotent: boolean }> {
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text || text.length > 300) {
      throw salesValidation([
        {
          path: 'reason',
          code: 'REASON_REQUIRED',
          message: 'Indique o motivo (até 300 caracteres).',
        },
      ])
    }
    return this.uow.run(async (scope) => {
      const shipment = await this.shipments.find(scope, id, true)
      if (!shipment) throw ApiError.notFound()
      if (shipment.status === 'REVERSED') {
        return { shipment: await this.detail(scope, id), idempotent: true }
      }
      if (shipment.status !== 'POSTED') {
        throw ApiError.conflict('SHIPMENT_NOT_POSTED', 'Só uma expedição lançada se reverte.')
      }
      const order = (await this.orders.find(scope, shipment.orderId, true)) as Order
      const lines = await this.shipments.listLines(scope, id)
      const orderLines = await this.orderLines.list(scope, { orderId: order.id })
      const reversed = await this.shipments.reverse(scope, id, text)
      await runReversedEffects(scope, reversed, order, this.refsOf(lines, orderLines))
      const after = await this.refreshOrder(scope, order, orderLines)
      await this.outbox.append(scope, {
        aggregateType: 'shipment',
        aggregateId: id,
        aggregateVersion: reversed.version,
        eventType: 'sales.shipment.reversed',
        payload: {
          shipmentId: id,
          number: shipment.number,
          orderId: order.id,
          orderStatus: after.status,
          reason: text,
        },
        correlationId: context.correlationId,
      })
      return { shipment: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  // --- auxiliares ----------------------------------------------------------------------------

  private async detail(scope: TenantScope, id: string): Promise<ShipmentDetail> {
    const shipment = await this.shipments.find(scope, id)
    if (!shipment) throw ApiError.notFound()
    return { ...shipment, lines: await this.shipments.listLines(scope, id) }
  }

  private async requireDraft(scope: TenantScope, id: string): Promise<Shipment> {
    const shipment = await this.shipments.find(scope, id, true)
    if (!shipment) throw ApiError.notFound()
    if (shipment.status !== 'DRAFT') {
      throw ApiError.conflict('SHIPMENT_NOT_DRAFT', 'Só uma expedição em rascunho se altera.')
    }
    return shipment
  }

  private assertShippable(order: Order): void {
    if (!canShip(order.status)) {
      throw ApiError.conflict(
        'ORDER_NOT_SHIPPABLE',
        order.status === 'FULFILLED'
          ? 'A encomenda já foi toda expedida.'
          : 'Só se expede uma encomenda confirmada.'
      )
    }
  }

  private balanceOf(
    orderLines: readonly Line[],
    shipped: ReadonlyMap<string, string>,
    orderLineId: string
  ): Balance | null {
    const line = orderLines.find((l) => l.id === orderLineId)
    if (!line) return null
    return {
      ordered: toScaled(line.quantity, 6) ?? 0n,
      shipped: toScaled(shipped.get(orderLineId) ?? '0', 6) ?? 0n,
    }
  }

  private refsOf(lines: readonly ShipmentLine[], orderLines: readonly Line[]): ShipmentLineRef[] {
    return lines.map((l) => ({
      id: l.id,
      orderLineId: l.orderLineId,
      variantId: orderLines.find((o) => o.id === l.orderLineId)?.variantId as string,
      quantity: l.quantity,
    }))
  }

  /** Recalcula o estado da encomenda a partir das expedições lançadas e não revertidas. */
  private async refreshOrder(scope: TenantScope, order: Order, orderLines: readonly Line[]) {
    const shipped = await this.shipments.shippedByLine(scope, order.id)
    const status = statusAfterShipping(
      orderLines.map((l) => this.balanceOf(orderLines, shipped, l.id) as Balance)
    )
    return this.orders.setFulfilment(scope, order.id, status)
  }

  private async addLineInScope(
    scope: TenantScope,
    shipment: Shipment,
    order: Order,
    raw: ShipmentLineInput,
    path: string
  ): Promise<void> {
    const issues: Issue[] = []
    const values = normalizeShipmentLine(raw, path, issues)
    if (!values) throw salesValidation(issues)
    await this.checkBalance(scope, order, values.orderLineId, values.quantity, `${path}quantity`)
    const created = await this.shipments.insertLine(scope, shipment.id, values)
    if (!created) {
      throw ApiError.conflict(
        'SHIPMENT_LINE_DUPLICATE',
        'Esta linha da encomenda já está na expedição: altere a quantidade.'
      )
    }
  }

  /** A linha pertence à encomenda, a quantidade respeita a unidade e cabe no saldo por expedir. */
  private async checkBalance(
    scope: TenantScope,
    order: Order,
    orderLineId: string,
    quantity: string,
    path: string
  ): Promise<void> {
    const orderLines = await this.orderLines.list(scope, { orderId: order.id })
    const line = orderLines.find((l) => l.id === orderLineId)
    if (!line) {
      throw salesValidation([
        {
          path: path.replace('quantity', 'orderLineId'),
          code: 'UNKNOWN_ORDER_LINE',
          message: 'A linha não pertence a esta encomenda.',
        },
      ])
    }
    const precision = await this.references.unitPrecision(scope.context, line.unitId)
    if (precision !== null && decimalPlaces(quantity) > precision) {
      throw salesValidation([
        {
          path,
          code: 'QUANTITY_PRECISION',
          message: `A unidade admite até ${precision} casas decimais.`,
        },
      ])
    }
    const shipped = await this.shipments.shippedByLine(scope, order.id)
    const balance = this.balanceOf(orderLines, shipped, orderLineId) as Balance
    if (!fits(balance, quantity)) {
      throw salesValidation([
        {
          path,
          code: 'EXCEEDS_BALANCE',
          message: `Só falta expedir ${quantityText(remaining(balance))}.`,
        },
      ])
    }
  }
}
