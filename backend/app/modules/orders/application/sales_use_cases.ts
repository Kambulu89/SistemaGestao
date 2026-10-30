import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  canCancel,
  canConfirm,
  canQuoteMove,
  effectiveQuoteStatus,
  normalizeOrderHeader,
  normalizeQuoteHeader,
  type Issue,
  type LineInput,
  type OrderHeaderInput,
  type OrderStatus,
  type QuoteHeaderInput,
  type QuoteStatus,
} from '#modules/orders/domain/sales'
import { LineEngine, salesValidation } from '#modules/orders/application/line_engine'
import type {
  CustomerRef,
  DocumentFilter,
  Line,
  LineStore,
  Order,
  OrderStore,
  Owner,
  Quote,
  QuoteStore,
  References,
  ShipmentStore,
} from '#modules/orders/application/ports'
import {
  runCancelledEffects,
  runConfirmationChecks,
  runConfirmedEffects,
} from '#modules/orders/application/registry'

const MAX_PAGE = 200

interface Clock {
  now(): Date
}

const today = (clock: Clock) => clock.now().toISOString().slice(0, 10)

export type QuoteDetail = Omit<Quote, 'status'> & { status: QuoteStatus; lines: Line[] }
/** `shippedQty` (só na leitura de uma encomenda) é a soma das expedições lançadas e não revertidas da linha. */
export type OrderDetail = Order & { lines: (Line & { shippedQty?: string })[] }

type ListFilter = Omit<DocumentFilter, 'today' | 'limit' | 'offset'> & {
  limit?: number
  offset?: number
}

/** Valida que o cliente existe, é da organização do documento e devolve-o (para a moeda por omissão). */
async function checkParties(
  references: References,
  context: TenantContext,
  organizationId: string,
  customerId: string,
  issues: Issue[]
): Promise<CustomerRef | null> {
  if (!(await references.organizationExists(context, organizationId))) {
    issues.push({
      path: 'organizationId',
      code: 'UNKNOWN_ORGANIZATION',
      message: 'A organização não existe.',
    })
    return null
  }
  const customer = await references.customer(context, customerId)
  if (!customer) {
    issues.push({ path: 'customerId', code: 'UNKNOWN_CUSTOMER', message: 'O cliente não existe.' })
    return null
  }
  if (customer.organizationId !== organizationId) {
    issues.push({
      path: 'customerId',
      code: 'CUSTOMER_ORGANIZATION',
      message: 'O cliente pertence a outra organização.',
    })
    return null
  }
  return customer
}

/** Propostas (M04): rascunho → enviada → aceite/rejeitada. A aceitação converte-se, de forma idempotente, numa encomenda. */
export class QuoteUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly quotes: QuoteStore,
    private readonly orders: OrderStore,
    private readonly lines: LineStore,
    private readonly engine: LineEngine,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  private present(quote: Quote, lines: Line[]): QuoteDetail {
    return {
      ...quote,
      status: effectiveQuoteStatus(quote.status, quote.validUntil, today(this.clock)),
      lines,
    }
  }

  async list(context: TenantContext, filter: ListFilter) {
    const { items, total } = await this.uow.run(
      (scope) =>
        this.quotes.list(scope, {
          ...filter,
          today: today(this.clock),
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
    return {
      items: items.map((q) => ({
        ...q,
        status: effectiveQuoteStatus(q.status, q.validUntil, today(this.clock)),
      })),
      total,
    }
  }

  get(context: TenantContext, id: string): Promise<QuoteDetail> {
    return this.uow.run(async (scope) => {
      const quote = await this.quotes.find(scope, id)
      if (!quote) throw ApiError.notFound()
      return this.present(quote, await this.lines.list(scope, { quoteId: id }))
    }, context)
  }

  async create(context: TenantContext, input: QuoteHeaderInput): Promise<QuoteDetail> {
    const issues: Issue[] = []
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    const customerId = typeof input.customerId === 'string' ? input.customerId : ''
    const customer =
      organizationId && customerId
        ? await checkParties(this.references, context, organizationId, customerId, issues)
        : null
    const values = normalizeQuoteHeader(
      input,
      null,
      customer?.currency ?? 'AOA',
      today(this.clock),
      issues
    )
    if (!values || issues.length > 0) throw salesValidation(issues)
    return this.uow.run(
      async (scope) => this.present(await this.quotes.insert(scope, values), []),
      context
    )
  }

  async update(
    context: TenantContext,
    id: string,
    input: QuoteHeaderInput & { expectedVersion: number }
  ): Promise<QuoteDetail> {
    for (const immutable of ['organizationId', 'customerId'] as const) {
      if (input[immutable] !== undefined) {
        throw salesValidation([
          { path: immutable, code: 'IMMUTABLE', message: 'A organização e o cliente não mudam.' },
        ])
      }
    }
    return this.uow.run(async (scope) => {
      const current = await this.quotes.find(scope, id, true)
      if (!current) throw ApiError.notFound()
      this.assertDraft(current.status)
      const lines = await this.lines.list(scope, { quoteId: id })
      const issues: Issue[] = []
      const values = normalizeQuoteHeader(
        input,
        current,
        current.currency,
        today(this.clock),
        issues
      )
      if (!values) throw salesValidation(issues)
      if (values.currency !== current.currency && lines.length > 0) {
        throw ApiError.conflict(
          'CURRENCY_LOCKED',
          'A moeda não muda depois de haver linhas (os preços são desta moeda).'
        )
      }
      const updated = await this.quotes.updateHeader(scope, id, input.expectedVersion, values)
      return this.present(updated, lines)
    }, context)
  }

  private assertDraft(status: QuoteStatus) {
    if (status !== 'DRAFT') {
      throw ApiError.conflict('QUOTE_NOT_DRAFT', 'Só uma proposta em rascunho se altera.')
    }
  }

  /** Recalcula os totais (a soma exacta das linhas) e devolve o documento. */
  private async retotal(scope: TenantScope, id: string): Promise<QuoteDetail> {
    const lines = await this.lines.list(scope, { quoteId: id })
    const quote = await this.quotes.setTotals(scope, id, this.engine.totals(lines))
    return this.present(quote, lines)
  }

  async addLine(context: TenantContext, id: string, input: LineInput): Promise<QuoteDetail> {
    const request = this.engine.request(input, null)
    const header = await this.uow.run(async (scope) => this.quotes.find(scope, id), context)
    if (!header) throw ApiError.notFound()
    // O preço resolve-se fora da transacção do documento (leitura); a linha só entra se o rascunho continuar rascunho.
    const values = await this.engine.build(
      context,
      { organizationId: header.organizationId, currency: header.currency, date: today(this.clock) },
      request
    )
    return this.uow.run(async (scope) => {
      const quote = await this.quotes.find(scope, id, true)
      if (!quote) throw ApiError.notFound()
      this.assertDraft(quote.status)
      await this.lines.insert(scope, { quoteId: id }, values)
      return this.retotal(scope, id)
    }, context)
  }

  async updateLine(
    context: TenantContext,
    id: string,
    lineId: string,
    input: LineInput
  ): Promise<QuoteDetail> {
    const owner: Owner = { quoteId: id }
    const loaded = await this.uow.run(async (scope) => {
      const quote = await this.quotes.find(scope, id)
      const line = quote ? await this.lines.find(scope, owner, lineId) : null
      return quote && line ? { quote, line } : null
    }, context)
    if (!loaded) throw ApiError.notFound()
    const request = this.engine.request(input, {
      variantId: loaded.line.variantId,
      quantity: loaded.line.quantity,
      discountRate: loaded.line.discountRate,
    })
    if (input.variantId !== undefined && input.variantId !== loaded.line.variantId) {
      throw salesValidation([
        {
          path: 'variantId',
          code: 'IMMUTABLE',
          message: 'Para outra variante, remova a linha e acrescente outra.',
        },
      ])
    }
    const values = await this.engine.build(
      context,
      {
        organizationId: loaded.quote.organizationId,
        currency: loaded.quote.currency,
        date: today(this.clock),
      },
      request
    )
    return this.uow.run(async (scope) => {
      const quote = await this.quotes.find(scope, id, true)
      if (!quote) throw ApiError.notFound()
      this.assertDraft(quote.status)
      if (!(await this.lines.find(scope, owner, lineId))) throw ApiError.notFound()
      await this.lines.update(scope, lineId, values)
      return this.retotal(scope, id)
    }, context)
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<QuoteDetail> {
    return this.uow.run(async (scope) => {
      const quote = await this.quotes.find(scope, id, true)
      if (!quote) throw ApiError.notFound()
      this.assertDraft(quote.status)
      if (!(await this.lines.find(scope, { quoteId: id }, lineId))) throw ApiError.notFound()
      await this.lines.remove(scope, lineId)
      return this.retotal(scope, id)
    }, context)
  }

  /** Enviar atribui o número (sequência `QUOTE`) e congela a proposta. */
  send(context: TenantContext, id: string): Promise<QuoteDetail> {
    return this.uow.run(async (scope) => {
      const quote = await this.quotes.find(scope, id, true)
      if (!quote) throw ApiError.notFound()
      this.assertDraft(quote.status)
      if (quote.validUntil < today(this.clock)) {
        throw ApiError.conflict(
          'QUOTE_EXPIRED',
          'A validade da proposta já passou: altere-a antes de enviar.'
        )
      }
      const lines = await this.lines.list(scope, { quoteId: id })
      if (lines.length === 0) {
        throw ApiError.conflict('QUOTE_EMPTY', 'Uma proposta sem linhas não se envia.')
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: quote.organizationId,
        documentType: 'QUOTE',
        date: this.clock.now(),
      })
      return this.present(
        await this.quotes.transition(scope, id, { status: 'SENT', number }),
        lines
      )
    }, context)
  }

  reject(context: TenantContext, id: string): Promise<QuoteDetail> {
    return this.uow.run(async (scope) => {
      const quote = await this.quotes.find(scope, id, true)
      if (!quote) throw ApiError.notFound()
      const status = effectiveQuoteStatus(quote.status, quote.validUntil, today(this.clock))
      if (status !== 'SENT') {
        throw ApiError.conflict('INVALID_STATE', `Uma proposta ${status} não se rejeita.`)
      }
      const lines = await this.lines.list(scope, { quoteId: id })
      return this.present(await this.quotes.transition(scope, id, { status: 'REJECTED' }), lines)
    }, context)
  }

  /**
   * Aceitar converte a proposta numa encomenda em rascunho, com as linhas **tal como foram propostas** (preços e impostos
   * congelados, sem recalcular). Idempotente: aceitar outra vez devolve a mesma encomenda.
   */
  accept(
    context: TenantContext,
    id: string
  ): Promise<{ quote: QuoteDetail; order: OrderDetail; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const quote = await this.quotes.find(scope, id, true)
      if (!quote) throw ApiError.notFound()
      const lines = await this.lines.list(scope, { quoteId: id })
      if (quote.status === 'ACCEPTED') {
        const existing = (await this.orders.findByQuote(scope, id)) as Order
        return {
          quote: this.present(quote, lines),
          order: { ...existing, lines: await this.lines.list(scope, { orderId: existing.id }) },
          idempotent: true,
        }
      }
      const status = effectiveQuoteStatus(quote.status, quote.validUntil, today(this.clock))
      if (!canQuoteMove(status, 'ACCEPTED')) {
        throw ApiError.conflict(
          status === 'EXPIRED' ? 'QUOTE_EXPIRED' : 'INVALID_STATE',
          status === 'EXPIRED' ? 'A proposta expirou.' : `Uma proposta ${status} não se aceita.`
        )
      }
      const order = await this.orders.insert(
        scope,
        {
          organizationId: quote.organizationId,
          customerId: quote.customerId,
          orderDate: today(this.clock),
          currency: quote.currency,
          deliveryAddress: null,
        },
        id
      )
      for (const line of lines) {
        await this.lines.insert(
          scope,
          { orderId: order.id },
          {
            variantId: line.variantId,
            descriptionSnapshot: line.descriptionSnapshot,
            quantity: line.quantity,
            unitId: line.unitId,
            unitPrice: line.unitPrice,
            discountRate: line.discountRate,
            taxRateSnapshot: line.taxRateSnapshot,
            taxInclusive: line.taxInclusive,
            netAmount: line.netAmount,
            taxAmount: line.taxAmount,
            total: line.total,
            priceOrigin: line.priceOrigin,
          }
        )
      }
      const orderLines = await this.lines.list(scope, { orderId: order.id })
      const withTotals = await this.orders.setTotals(
        scope,
        order.id,
        this.engine.totals(orderLines)
      )
      const accepted = await this.quotes.transition(scope, id, { status: 'ACCEPTED' })
      await this.outbox.append(scope, {
        aggregateType: 'sales_quote',
        aggregateId: id,
        aggregateVersion: accepted.version,
        eventType: 'sales.quote.accepted',
        payload: {
          quoteId: id,
          orderId: order.id,
          customerId: quote.customerId,
          organizationId: quote.organizationId,
          total: quote.totals.total,
          currency: quote.currency,
        },
        correlationId: context.correlationId,
      })
      return {
        quote: this.present(accepted, lines),
        order: { ...withTotals, lines: orderLines },
        idempotent: false,
      }
    }, context)
  }
}

/** Encomendas (M04): rascunho → confirmada → (expedida, noutra fatia) | cancelada. Confirmar não reserva nem expede. */
export class OrderUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly orders: OrderStore,
    private readonly lines: LineStore,
    private readonly engine: LineEngine,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    private readonly shipments?: ShipmentStore
  ) {}

  list(context: TenantContext, filter: ListFilter) {
    return this.uow.run(
      (scope) =>
        this.orders.list(scope, {
          ...filter,
          today: today(this.clock),
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<OrderDetail> {
    return this.uow.run(async (scope) => {
      const order = await this.orders.find(scope, id)
      if (!order) throw ApiError.notFound()
      const lines = await this.lines.list(scope, { orderId: id })
      const shipped = this.shipments ? await this.shipments.shippedByLine(scope, id) : new Map()
      return {
        ...order,
        lines: lines.map((l) => ({ ...l, shippedQty: shipped.get(l.id) ?? '0.000000' })),
      }
    }, context)
  }

  async create(context: TenantContext, input: OrderHeaderInput): Promise<OrderDetail> {
    const issues: Issue[] = []
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    const customerId = typeof input.customerId === 'string' ? input.customerId : ''
    const customer =
      organizationId && customerId
        ? await checkParties(this.references, context, organizationId, customerId, issues)
        : null
    const values = normalizeOrderHeader(
      input,
      null,
      customer?.currency ?? 'AOA',
      today(this.clock),
      issues
    )
    if (!values || issues.length > 0) throw salesValidation(issues)
    return this.uow.run(
      async (scope) => ({ ...(await this.orders.insert(scope, values, null)), lines: [] }),
      context
    )
  }

  async update(
    context: TenantContext,
    id: string,
    input: OrderHeaderInput & { expectedVersion: number }
  ): Promise<OrderDetail> {
    for (const immutable of ['organizationId', 'customerId'] as const) {
      if (input[immutable] !== undefined) {
        throw salesValidation([
          { path: immutable, code: 'IMMUTABLE', message: 'A organização e o cliente não mudam.' },
        ])
      }
    }
    return this.uow.run(async (scope) => {
      const current = await this.orders.find(scope, id, true)
      if (!current) throw ApiError.notFound()
      this.assertDraft(current.status)
      const lines = await this.lines.list(scope, { orderId: id })
      const issues: Issue[] = []
      const values = normalizeOrderHeader(
        input,
        current,
        current.currency,
        today(this.clock),
        issues
      )
      if (!values) throw salesValidation(issues)
      if (values.currency !== current.currency && lines.length > 0) {
        throw ApiError.conflict(
          'CURRENCY_LOCKED',
          'A moeda não muda depois de haver linhas (os preços são desta moeda).'
        )
      }
      return {
        ...(await this.orders.updateHeader(scope, id, input.expectedVersion, values)),
        lines,
      }
    }, context)
  }

  private assertDraft(status: OrderStatus) {
    if (status !== 'DRAFT') {
      throw ApiError.conflict('ORDER_NOT_DRAFT', 'Só uma encomenda em rascunho se altera.')
    }
  }

  private async retotal(scope: TenantScope, id: string): Promise<OrderDetail> {
    const lines = await this.lines.list(scope, { orderId: id })
    const order = await this.orders.setTotals(scope, id, this.engine.totals(lines))
    return { ...order, lines }
  }

  async addLine(context: TenantContext, id: string, input: LineInput): Promise<OrderDetail> {
    const request = this.engine.request(input, null)
    const header = await this.uow.run((scope) => this.orders.find(scope, id), context)
    if (!header) throw ApiError.notFound()
    const values = await this.engine.build(
      context,
      { organizationId: header.organizationId, currency: header.currency, date: header.orderDate },
      request
    )
    return this.uow.run(async (scope) => {
      const order = await this.orders.find(scope, id, true)
      if (!order) throw ApiError.notFound()
      this.assertDraft(order.status)
      await this.lines.insert(scope, { orderId: id }, values)
      return this.retotal(scope, id)
    }, context)
  }

  async updateLine(
    context: TenantContext,
    id: string,
    lineId: string,
    input: LineInput
  ): Promise<OrderDetail> {
    const owner: Owner = { orderId: id }
    const loaded = await this.uow.run(async (scope) => {
      const order = await this.orders.find(scope, id)
      const line = order ? await this.lines.find(scope, owner, lineId) : null
      return order && line ? { order, line } : null
    }, context)
    if (!loaded) throw ApiError.notFound()
    if (input.variantId !== undefined && input.variantId !== loaded.line.variantId) {
      throw salesValidation([
        {
          path: 'variantId',
          code: 'IMMUTABLE',
          message: 'Para outra variante, remova a linha e acrescente outra.',
        },
      ])
    }
    const request = this.engine.request(input, {
      variantId: loaded.line.variantId,
      quantity: loaded.line.quantity,
      discountRate: loaded.line.discountRate,
    })
    const values = await this.engine.build(
      context,
      {
        organizationId: loaded.order.organizationId,
        currency: loaded.order.currency,
        date: loaded.order.orderDate,
      },
      request
    )
    return this.uow.run(async (scope) => {
      const order = await this.orders.find(scope, id, true)
      if (!order) throw ApiError.notFound()
      this.assertDraft(order.status)
      if (!(await this.lines.find(scope, owner, lineId))) throw ApiError.notFound()
      await this.lines.update(scope, lineId, values)
      return this.retotal(scope, id)
    }, context)
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<OrderDetail> {
    return this.uow.run(async (scope) => {
      const order = await this.orders.find(scope, id, true)
      if (!order) throw ApiError.notFound()
      this.assertDraft(order.status)
      if (!(await this.lines.find(scope, { orderId: id }, lineId))) throw ApiError.notFound()
      await this.lines.remove(scope, lineId)
      return this.retotal(scope, id)
    }, context)
  }

  /**
   * Confirmar valida o cliente (activo, sem bloqueio), exige linhas, corre as verificações registadas (stock, crédito) e
   * emite o número. **Não expede nem factura**: `sales.order.confirmed` é o aviso de compromisso; a reserva de stock corre
   * por um efeito registado pelo inventário (na mesma transacção), as expedições e as facturas são operações próprias. Idempotente: confirmar outra vez devolve a encomenda.
   */
  confirm(
    context: TenantContext,
    id: string,
    expectedVersion?: number
  ): Promise<{ order: OrderDetail; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const order = await this.orders.find(scope, id, true)
      if (!order) throw ApiError.notFound()
      const lines = await this.lines.list(scope, { orderId: id })
      if (order.status === 'CANCELLED') {
        throw ApiError.conflict('ORDER_CANCELLED', 'A encomenda está cancelada.')
      }
      if (!canConfirm(order.status)) return { order: { ...order, lines }, idempotent: true }
      if (expectedVersion !== undefined && expectedVersion !== order.version) {
        throw ApiError.versionConflict(order.version)
      }
      if (lines.length === 0) {
        throw ApiError.conflict('ORDER_EMPTY', 'Uma encomenda sem linhas não se confirma.')
      }
      await this.references.assertSaleAllowed(context, order.customerId)
      const problems = await runConfirmationChecks(scope, order, lines)
      if (problems.length > 0) {
        throw new ApiError(
          409,
          'ORDER_NOT_CONFIRMABLE',
          'A encomenda não pode ser confirmada.',
          problems
        )
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: order.organizationId,
        documentType: 'SALES_ORDER',
        date: this.clock.now(),
      })
      const confirmed = await this.orders.confirm(scope, id, number)
      await this.outbox.append(scope, {
        aggregateType: 'sales_order',
        aggregateId: id,
        aggregateVersion: confirmed.version,
        eventType: 'sales.order.confirmed',
        payload: {
          orderId: id,
          number,
          customerId: order.customerId,
          organizationId: order.organizationId,
          total: order.totals.total,
          currency: order.currency,
          lines: lines.map((l) => ({
            lineId: l.id,
            variantId: l.variantId,
            quantity: l.quantity,
            unitId: l.unitId,
          })),
        },
        correlationId: context.correlationId,
      })
      // Reservas de stock e afins: na mesma transacção, por isso um erro aqui anula a confirmação por inteiro.
      await runConfirmedEffects(scope, confirmed, lines)
      return { order: { ...confirmed, lines }, idempotent: false }
    }, context)
  }

  /**
   * Cancelar uma encomenda em rascunho ou confirmada (com motivo). Cancelar duas vezes é inofensivo. Uma encomenda já
   * expedida (parcial ou totalmente) não se cancela: reverte-se pelas operações próprias. As reservas (4.4) libertam-se ao
   * consumir `sales.order.cancelled`.
   */
  cancel(
    context: TenantContext,
    id: string,
    reason: string
  ): Promise<{ order: OrderDetail; idempotent: boolean }> {
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
      const order = await this.orders.find(scope, id, true)
      if (!order) throw ApiError.notFound()
      const lines = await this.lines.list(scope, { orderId: id })
      if (order.status === 'CANCELLED') return { order: { ...order, lines }, idempotent: true }
      if (!canCancel(order.status)) {
        throw ApiError.conflict(
          'ORDER_NOT_CANCELLABLE',
          'Uma encomenda já expedida não se cancela: reverta as expedições.'
        )
      }
      const cancelled = await this.orders.cancel(scope, id, text)
      await this.outbox.append(scope, {
        aggregateType: 'sales_order',
        aggregateId: id,
        aggregateVersion: cancelled.version,
        eventType: 'sales.order.cancelled',
        payload: {
          orderId: id,
          number: order.number,
          wasConfirmed: order.status === 'CONFIRMED',
          customerId: order.customerId,
          organizationId: order.organizationId,
          reason: text,
        },
        correlationId: context.correlationId,
      })
      await runCancelledEffects(scope, cancelled, lines)
      return { order: { ...cancelled, lines }, idempotent: false }
    }, context)
  }
}
