import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { fromScaled, sumTotals, toScaled } from '#modules/orders/index'
import {
  addDays,
  billableQuantity,
  isIsoDate,
  manualLineValues,
  type InvoiceLineValues,
  type InvoiceStatus,
  type Issue,
  type ManualLineInput,
} from '#modules/invoicing/domain/invoicing'
import { orderLineValues } from '#modules/invoicing/application/order_line_values'
import { runIssuedEffects } from '#modules/invoicing/application/registry'
import { invoicingValidation } from '#modules/invoicing/application/contract_use_cases'
import type {
  ContractStore,
  Invoice,
  InvoiceLine,
  InvoiceStore,
  OrderLineRef,
  OrderRef,
  References,
} from '#modules/invoicing/application/ports'

const MAX_PAGE = 200
const MAX_LINES = 100
/** Estados da encomenda a partir dos quais já se pode facturar. */
const BILLABLE_ORDER = new Set(['CONFIRMED', 'PARTIAL', 'FULFILLED'])

interface Clock {
  now(): Date
}

export type InvoiceDetail = Invoice & { lines: InvoiceLine[] }

export interface InvoiceLineInput extends ManualLineInput {
  /** Linha da encomenda a facturar; sem ela a linha é livre (só em facturas sem encomenda). */
  orderLineId?: unknown
}

export interface InvoiceInput {
  orderId?: string
  organizationId?: string
  customerId?: string
  contractId?: string | null
  dueOn?: string
  notes?: string | null
  lines?: InvoiceLineInput[]
}

export interface BillableLine {
  orderLineId: string
  variantId: string
  description: string
  ordered: string
  shipped: string
  billed: string
  billable: string
  stockTracked: boolean
}

/**
 * Facturas (M05): rascunho → emitida → (creditada). Emitir é uma operação distinta de confirmar e de expedir: atribui o
 * número, fixa o instantâneo do cliente e da política de arredondamento e regista o evento, tudo na mesma transacção. O
 * que se pode facturar de uma encomenda é o expedido (bens com stock) ou o encomendado (serviços) menos o já facturado,
 * conferido sob bloqueio da encomenda, por isso duas facturas concorrentes nunca facturam duas vezes a mesma quantidade.
 */
export class InvoiceUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly invoices: InvoiceStore,
    private readonly contracts: ContractStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10)
  }

  list(
    context: TenantContext,
    filter: {
      customerId?: string
      orderId?: string
      contractId?: string
      status?: InvoiceStatus
      q?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(
      (scope) =>
        this.invoices.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<InvoiceDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  /** O que ainda se pode facturar de uma encomenda, linha a linha (para preparar a factura). */
  billable(context: TenantContext, orderId: string): Promise<BillableLine[]> {
    return this.uow.run(async (scope) => {
      const order = await this.references.order(context, orderId)
      if (!order) throw ApiError.notFound()
      return this.billableLines(scope, context, order)
    }, context)
  }

  async create(context: TenantContext, input: InvoiceInput): Promise<InvoiceDetail> {
    const issues: Issue[] = []
    if (input.dueOn !== undefined && !isIsoDate(input.dueOn)) {
      issues.push({
        path: 'dueOn',
        code: 'INVALID_DATE',
        message: 'O vencimento tem de ser AAAA-MM-DD.',
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
    if ((input.lines?.length ?? 0) > MAX_LINES) {
      issues.push({ path: 'lines', code: 'TOO_MANY', message: `No máximo ${MAX_LINES} linhas.` })
    }
    if (!input.orderId && (!input.customerId || !input.organizationId)) {
      issues.push({
        path: input.customerId ? 'organizationId' : 'customerId',
        code: 'REQUIRED',
        message: 'Indique a encomenda, ou o cliente e a organização.',
      })
    }
    if (issues.length > 0) throw invoicingValidation(issues)
    return this.uow.run(async (scope) => {
      let order: OrderRef | null = null
      if (input.orderId) {
        order = await this.references.order(context, input.orderId)
        if (!order) throw ApiError.notFound()
        this.assertBillable(order)
      }
      const customerId = order?.customerId ?? (input.customerId as string)
      const customer = await this.references.customer(context, customerId)
      if (!customer) {
        throw invoicingValidation([
          { path: 'customerId', code: 'UNKNOWN_CUSTOMER', message: 'O cliente não existe.' },
        ])
      }
      const organizationId = order?.organizationId ?? (input.organizationId as string)
      if (customer.organizationId !== organizationId) {
        throw invoicingValidation([
          {
            path: 'organizationId',
            code: 'ORGANIZATION_MISMATCH',
            message: 'O cliente pertence a outra organização.',
          },
        ])
      }
      const contractId = input.contractId ?? null
      if (contractId) await this.assertContract(scope, contractId, customer.partyId)
      const created = await this.invoices.insert(scope, {
        organizationId,
        customerId,
        contractId,
        orderId: order?.id ?? null,
        dueOn: input.dueOn ?? addDays(this.today(), customer.paymentTermDays),
        currency: order?.currency ?? customer.currency,
        notes,
      })
      if (order) await this.invoices.lock(scope, `order:${order.id}`)
      const mode = await this.references.roundingMode(context, organizationId)
      let raw: InvoiceLineInput[] = input.lines ?? []
      if (!input.lines && order) {
        const open = await this.billableLines(scope, context, order)
        raw = open
          .filter((l) => toScaled(l.billable, 6) !== 0n)
          .map((l) => ({ orderLineId: l.orderLineId }))
      }
      if (order && raw.length === 0) {
        throw ApiError.conflict('NOTHING_TO_INVOICE', 'Esta encomenda não tem nada por facturar.')
      }
      for (const [index, line] of raw.entries()) {
        await this.addLineInScope(scope, context, created, order, line, `lines[${index}].`, mode)
      }
      return this.retotal(scope, created.id)
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      dueOn?: string
      notes?: string | null
      contractId?: string | null
    }
  ): Promise<InvoiceDetail> {
    if (input.dueOn !== undefined && !isIsoDate(input.dueOn)) {
      throw invoicingValidation([
        { path: 'dueOn', code: 'INVALID_DATE', message: 'O vencimento tem de ser AAAA-MM-DD.' },
      ])
    }
    const notes =
      input.notes === undefined
        ? undefined
        : typeof input.notes === 'string'
          ? input.notes.trim() || null
          : null
    if (notes && notes.length > 1000) {
      throw invoicingValidation([
        { path: 'notes', code: 'TOO_LONG', message: 'As notas têm no máximo 1000 caracteres.' },
      ])
    }
    return this.uow.run(async (scope) => {
      const invoice = await this.requireDraft(scope, id)
      if (input.contractId) {
        const customer = await this.references.customer(context, invoice.customerId)
        await this.assertContract(
          scope,
          input.contractId,
          (customer as { partyId: string }).partyId
        )
      }
      await this.invoices.updateHeader(scope, id, input.expectedVersion, {
        dueOn: input.dueOn ?? invoice.dueOn,
        notes: notes === undefined ? invoice.notes : notes,
        contractId: input.contractId === undefined ? invoice.contractId : input.contractId,
      })
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      await this.invoices.remove(scope, id)
    }, context)
  }

  addLine(context: TenantContext, id: string, input: InvoiceLineInput): Promise<InvoiceDetail> {
    return this.uow.run(async (scope) => {
      const invoice = await this.requireDraft(scope, id)
      const order = invoice.orderId ? await this.references.order(context, invoice.orderId) : null
      if (order) this.assertBillable(order)
      const existing = await this.invoices.listLines(scope, id)
      if (existing.length >= MAX_LINES) {
        throw invoicingValidation([
          { path: 'lines', code: 'TOO_MANY', message: `No máximo ${MAX_LINES} linhas.` },
        ])
      }
      const mode = await this.references.roundingMode(context, invoice.organizationId)
      await this.addLineInScope(scope, context, invoice, order, input, '', mode)
      return this.retotal(scope, id)
    }, context)
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<InvoiceDetail> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      if (!(await this.invoices.findLine(scope, id, lineId))) throw ApiError.notFound()
      await this.invoices.removeLine(scope, lineId)
      return this.retotal(scope, id)
    }, context)
  }

  /**
   * Emite a factura: confere a elegibilidade sob bloqueio da encomenda, fixa o cliente e a morada (instantâneo), atribui
   * o número e regista o evento. Um erro em qualquer passo anula tudo (sem número gasto). Idempotente: emitir outra vez
   * devolve a factura já emitida, sem novo número nem evento.
   */
  issue(
    context: TenantContext,
    id: string
  ): Promise<{ invoice: InvoiceDetail; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const invoice = await this.invoices.find(scope, id, true)
      if (!invoice) throw ApiError.notFound()
      if (invoice.status !== 'DRAFT') {
        return { invoice: await this.detail(scope, id), idempotent: true }
      }
      if (invoice.orderId) await this.invoices.lock(scope, `order:${invoice.orderId}`)
      const lines = await this.invoices.listLines(scope, id)
      if (lines.length === 0) {
        throw ApiError.conflict('INVOICE_EMPTY', 'Uma factura sem linhas não se emite.')
      }
      const issuedOn = this.today()
      if (invoice.dueOn < issuedOn) {
        throw ApiError.conflict(
          'DUE_BEFORE_ISSUE',
          'O vencimento não pode ser anterior à data de emissão.',
          [{ path: 'dueOn', code: 'DUE_BEFORE_ISSUE', message: 'Corrija o vencimento.' }]
        )
      }
      if (invoice.orderId) {
        const order = await this.references.order(context, invoice.orderId)
        if (!order) throw ApiError.notFound()
        this.assertBillable(order)
        const open = await this.billableLines(scope, context, order)
        const eligible = new Map(open.map((l) => [l.orderLineId, l]))
        const problems: Issue[] = []
        for (const [index, line] of lines.entries()) {
          const room = eligible.get(line.salesOrderLineId ?? '')
          if (!room || (toScaled(line.quantity, 6) ?? 0n) > (toScaled(room.billable, 6) ?? 0n)) {
            problems.push({
              path: `lines[${index}].quantity`,
              code: 'EXCEEDS_BILLABLE',
              message: `Só se pode facturar ${room?.billable ?? '0'}.`,
            })
          }
        }
        if (problems.length > 0) {
          throw new ApiError(
            409,
            'INVOICE_NOT_ISSUABLE',
            'A factura não pode ser emitida.',
            problems
          )
        }
      }
      const customer = await this.references.customer(context, invoice.customerId)
      if (!customer) throw ApiError.notFound()
      const snapshot = await this.references.customerSnapshot(context, customer)
      const roundingMode = await this.references.roundingMode(context, invoice.organizationId)
      const number = await this.references.issueNumber(scope, {
        organizationId: invoice.organizationId,
        documentType: 'INVOICE',
        date: this.clock.now(),
      })
      const issued = await this.invoices.issue(scope, id, {
        number,
        issuedOn,
        snapshot,
        roundingMode,
      })
      await this.outbox.append(scope, {
        aggregateType: 'invoice',
        aggregateId: id,
        aggregateVersion: issued.version,
        eventType: 'invoicing.invoice.issued',
        payload: {
          invoiceId: id,
          number,
          organizationId: invoice.organizationId,
          customerId: invoice.customerId,
          orderId: invoice.orderId,
          contractId: invoice.contractId,
          issuedOn,
          dueOn: invoice.dueOn,
          currency: invoice.currency,
          totals: issued.totals,
        },
        correlationId: context.correlationId,
      })
      // O recebível (e afins): um erro aqui anula a emissão por inteiro.
      await runIssuedEffects(scope, issued)
      return { invoice: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  // --- auxiliares ----------------------------------------------------------------------------

  private async detail(scope: TenantScope, id: string): Promise<InvoiceDetail> {
    const invoice = await this.invoices.find(scope, id)
    if (!invoice) throw ApiError.notFound()
    return { ...invoice, lines: await this.invoices.listLines(scope, id) }
  }

  private async requireDraft(scope: TenantScope, id: string): Promise<Invoice> {
    const invoice = await this.invoices.find(scope, id, true)
    if (!invoice) throw ApiError.notFound()
    if (invoice.status !== 'DRAFT') {
      throw ApiError.conflict('INVOICE_NOT_DRAFT', 'Só uma factura em rascunho se altera.')
    }
    return invoice
  }

  private assertBillable(order: OrderRef): void {
    if (!BILLABLE_ORDER.has(order.status)) {
      throw ApiError.conflict(
        'ORDER_NOT_BILLABLE',
        'Só se factura uma encomenda confirmada (ou parcial/totalmente expedida).'
      )
    }
  }

  private async assertContract(scope: TenantScope, contractId: string, partyId: string) {
    const contract = await this.contracts.find(scope, contractId)
    if (!contract) {
      throw invoicingValidation([
        { path: 'contractId', code: 'UNKNOWN_CONTRACT', message: 'O contrato não existe.' },
      ])
    }
    if (contract.partyId !== partyId || contract.type === 'PURCHASE') {
      throw invoicingValidation([
        {
          path: 'contractId',
          code: 'CONTRACT_MISMATCH',
          message: 'O contrato tem de ser de venda ou serviço do mesmo cliente.',
        },
      ])
    }
    if (contract.status !== 'ACTIVE') {
      throw ApiError.conflict(
        'CONTRACT_NOT_ACTIVE',
        'Só se factura ao abrigo de um contrato activo.'
      )
    }
  }

  private async billableLines(
    scope: TenantScope,
    context: TenantContext,
    order: OrderRef
  ): Promise<BillableLine[]> {
    const billed = await this.invoices.billedByOrderLine(scope, order.id)
    const result: BillableLine[] = []
    for (const line of order.lines) {
      const stockTracked = await this.references.stockTracked(context, line.variantId)
      const room = billableQuantity({
        ordered: toScaled(line.quantity, 6) ?? 0n,
        shipped: toScaled(line.shippedQty, 6) ?? 0n,
        billed: toScaled(billed.get(line.id) ?? '0', 6) ?? 0n,
        stockTracked,
      })
      result.push({
        orderLineId: line.id,
        variantId: line.variantId,
        description: line.description,
        ordered: line.quantity,
        shipped: line.shippedQty,
        billed: billed.get(line.id) ?? '0.000000',
        billable: fromScaled(room, 6),
        stockTracked,
      })
    }
    return result
  }

  private async addLineInScope(
    scope: TenantScope,
    context: TenantContext,
    invoice: Invoice,
    order: OrderRef | null,
    raw: InvoiceLineInput,
    path: string,
    mode: Parameters<typeof orderLineValues>[2]
  ): Promise<void> {
    const issues: Issue[] = []
    let values: InvoiceLineValues | null
    if (raw.orderLineId !== undefined) {
      if (!order) {
        throw invoicingValidation([
          {
            path: `${path}orderLineId`,
            code: 'NO_ORDER',
            message: 'Esta factura não tem encomenda.',
          },
        ])
      }
      const line: OrderLineRef | undefined = order.lines.find((l) => l.id === raw.orderLineId)
      if (!line) {
        throw invoicingValidation([
          {
            path: `${path}orderLineId`,
            code: 'UNKNOWN_ORDER_LINE',
            message: 'A linha não pertence a esta encomenda.',
          },
        ])
      }
      const open = await this.billableLines(scope, context, order)
      const room = open.find((l) => l.orderLineId === line.id) as BillableLine
      const quantity = raw.quantity === undefined ? room.billable : raw.quantity
      const q = typeof quantity === 'string' ? toScaled(quantity, 6) : null
      if (q === null || q <= 0n || !/^\d{1,13}(\.\d{1,6})?$/.test(quantity as string)) {
        throw invoicingValidation([
          {
            path: `${path}quantity`,
            code: 'INVALID_QUANTITY',
            message: 'Quantidade positiva com até 6 casas.',
          },
        ])
      }
      if (q > (toScaled(room.billable, 6) ?? 0n)) {
        throw invoicingValidation([
          {
            path: `${path}quantity`,
            code: 'EXCEEDS_BILLABLE',
            message: `Só se pode facturar ${room.billable}.`,
          },
        ])
      }
      values = orderLineValues(
        {
          id: line.id,
          variantId: line.variantId,
          description: line.description,
          unitPrice: line.unitPrice,
          discountRate: line.discountRate,
          taxRate: line.taxRate,
          taxInclusive: line.taxInclusive,
        },
        quantity as string,
        mode
      )
      if (!values) {
        throw invoicingValidation([
          {
            path: `${path}quantity`,
            code: 'INVALID_LINE',
            message: 'Não foi possível calcular a linha.',
          },
        ])
      }
    } else {
      if (order) {
        throw invoicingValidation([
          {
            path: `${path}orderLineId`,
            code: 'ORDER_LINE_REQUIRED',
            message: 'Uma factura de encomenda só tem linhas da encomenda.',
          },
        ])
      }
      values = manualLineValues(raw, path, mode, issues)
      if (!values) throw invoicingValidation(issues)
    }
    if (values.salesOrderLineId) {
      const present = await this.invoices.listLines(scope, invoice.id)
      const exists = present.some((l) => l.salesOrderLineId === values?.salesOrderLineId)
      if (exists) {
        throw ApiError.conflict(
          'INVOICE_LINE_DUPLICATE',
          'Esta linha da encomenda já está na factura: remova-a para a refazer.'
        )
      }
    }
    await this.invoices.insertLine(scope, invoice.id, values)
  }

  private async retotal(scope: TenantScope, id: string): Promise<InvoiceDetail> {
    const lines = await this.invoices.listLines(scope, id)
    await this.invoices.setTotals(
      scope,
      id,
      sumTotals(lines.map((l) => ({ net: l.netAmount, tax: l.taxAmount, total: l.total })))
    )
    return this.detail(scope, id)
  }
}
