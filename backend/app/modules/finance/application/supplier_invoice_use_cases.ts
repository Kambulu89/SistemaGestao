import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  matchInvoice,
  normalizeSupplierInvoiceHeader,
  sumInvoiceLines,
  supplierInvoiceLine,
  type Issue,
  type SupplierInvoiceHeaderInput,
  type SupplierInvoiceLineInput,
  type SupplierInvoiceStatus,
} from '#modules/finance/domain/finance'
import {
  failure,
  financeValidation,
  MAX_LINES,
  MAX_PAGE,
  todayOf,
  type Clock,
} from '#modules/finance/application/errors'
import type {
  Discrepancy,
  ObligationStore,
  References,
  SupplierInvoice,
  SupplierInvoiceLine,
  SupplierInvoiceStore,
} from '#modules/finance/application/ports'

export type SupplierInvoiceDetail = SupplierInvoice & { lines: SupplierInvoiceLine[] }

export interface SupplierInvoiceInput extends SupplierInvoiceHeaderInput {
  lines?: SupplierInvoiceLineInput[]
}

/**
 * Facturas de fornecedor (contas a pagar). Rascunho livre; validar confere-a (a três vias, se tem encomenda: não se
 * factura mais do que o recebido nem a preço acima do encomendado) e cria o pagável. Com divergências a factura fica
 * «em disputa» e só avança com uma justificação de quem tem a permissão de excepção. Validada, é imutável.
 */
export class SupplierInvoiceUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly invoices: SupplierInvoiceStore,
    private readonly obligations: ObligationStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: {
      supplierId?: string
      status?: SupplierInvoiceStatus
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

  get(context: TenantContext, id: string): Promise<SupplierInvoiceDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  private async detail(scope: TenantScope, id: string): Promise<SupplierInvoiceDetail> {
    const invoice = await this.invoices.find(scope, id)
    if (!invoice) throw ApiError.notFound()
    return { ...invoice, lines: await this.invoices.lines(scope, id) }
  }

  async create(
    context: TenantContext,
    input: SupplierInvoiceInput
  ): Promise<SupplierInvoiceDetail> {
    const issues: Issue[] = []
    const supplierId = typeof input.supplierId === 'string' ? input.supplierId : ''
    const supplier = supplierId ? await this.references.supplier(context, supplierId) : null
    if (supplierId && !supplier) {
      throw failure('supplierId', 'UNKNOWN_SUPPLIER', 'O fornecedor não existe.')
    }
    const organizationId =
      typeof input.organizationId === 'string'
        ? input.organizationId
        : (supplier?.organizationId ?? '')
    const header = normalizeSupplierInvoiceHeader(
      { ...input, organizationId },
      null,
      {
        currency: supplier?.currency ?? 'AOA',
        paymentTermDays: supplier?.paymentTermDays ?? 0,
        today: todayOf(this.clock),
      },
      issues
    )
    if (!header) throw financeValidation(issues)
    if (supplier && supplier.organizationId !== header.organizationId) {
      throw failure(
        'organizationId',
        'SUPPLIER_ORGANIZATION',
        'O fornecedor pertence a outra organização.'
      )
    }
    if ((input.lines?.length ?? 0) > MAX_LINES) {
      throw failure('lines', 'TOO_MANY', `No máximo ${MAX_LINES} linhas.`)
    }
    await this.checkPurchase(context, header.purchaseOrderId, header.supplierId, header.currency)
    const mode = await this.references.roundingMode(context, header.organizationId)
    const lines = (input.lines ?? []).map((l, i) =>
      supplierInvoiceLine(l, `lines[${i}]`, mode, issues)
    )
    if (issues.length > 0) throw financeValidation(issues)
    return this.uow.run(async (scope) => {
      const created = await this.invoices.insert(scope, header)
      if (created === 'NUMBER') throw this.duplicateNumber()
      for (const line of lines) await this.invoices.insertLine(scope, created.id, line!)
      if (lines.length > 0) {
        await this.invoices.setTotals(scope, created.id, sumInvoiceLines(lines as never))
      }
      return this.detail(scope, created.id)
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    input: SupplierInvoiceHeaderInput & { expectedVersion: number }
  ): Promise<SupplierInvoiceDetail> {
    const current = await this.get(context, id)
    this.assertEditable(current)
    const issues: Issue[] = []
    const supplier = await this.references.supplier(context, current.supplierId)
    const header = normalizeSupplierInvoiceHeader(
      input,
      current,
      {
        currency: current.currency,
        paymentTermDays: supplier?.paymentTermDays ?? 0,
        today: todayOf(this.clock),
      },
      issues
    )
    if (!header) throw financeValidation(issues)
    await this.checkPurchase(context, header.purchaseOrderId, header.supplierId, header.currency)
    return this.uow.run(async (scope) => {
      const locked = await this.invoices.find(scope, id, true)
      if (!locked) throw ApiError.notFound()
      this.assertEditable(locked)
      const updated = await this.invoices.updateHeader(scope, id, input.expectedVersion, header)
      if (updated === 'NUMBER') throw this.duplicateNumber()
      return this.detail(scope, id)
    }, context)
  }

  async addLine(
    context: TenantContext,
    id: string,
    input: SupplierInvoiceLineInput
  ): Promise<SupplierInvoiceDetail> {
    const current = await this.get(context, id)
    this.assertEditable(current)
    if (current.lines.length >= MAX_LINES) {
      throw failure('lines', 'TOO_MANY', `No máximo ${MAX_LINES} linhas.`)
    }
    const issues: Issue[] = []
    const mode = await this.references.roundingMode(context, current.organizationId)
    const line = supplierInvoiceLine(input, 'line', mode, issues)
    if (!line) throw financeValidation(issues)
    if (line.purchaseLineId && !current.purchaseOrderId) {
      throw failure('purchaseLineId', 'NO_PURCHASE_ORDER', 'A factura não tem encomenda associada.')
    }
    return this.uow.run(async (scope) => {
      const locked = await this.invoices.find(scope, id, true)
      if (!locked) throw ApiError.notFound()
      this.assertEditable(locked)
      await this.invoices.insertLine(scope, id, line)
      const lines = await this.invoices.lines(scope, id)
      await this.invoices.setTotals(scope, id, sumInvoiceLines(lines))
      return this.detail(scope, id)
    }, context)
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<SupplierInvoiceDetail> {
    return this.uow.run(async (scope) => {
      const locked = await this.invoices.find(scope, id, true)
      if (!locked) throw ApiError.notFound()
      this.assertEditable(locked)
      if (!(await this.invoices.removeLine(scope, id, lineId))) throw ApiError.notFound()
      await this.invoices.setTotals(
        scope,
        id,
        sumInvoiceLines(await this.invoices.lines(scope, id))
      )
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const locked = await this.invoices.find(scope, id, true)
      if (!locked) throw ApiError.notFound()
      if (locked.status !== 'DRAFT') {
        throw ApiError.conflict('SUPPLIER_INVOICE_STATE', 'Só se apaga uma factura em rascunho.')
      }
      await this.invoices.remove(scope, id)
    }, context)
  }

  async voidInvoice(context: TenantContext, id: string): Promise<SupplierInvoiceDetail> {
    return this.uow.run(async (scope) => {
      const locked = await this.invoices.find(scope, id, true)
      if (!locked) throw ApiError.notFound()
      if (locked.status === 'VOID') return this.detail(scope, id)
      if (locked.status === 'VALIDATED') {
        throw ApiError.conflict('SUPPLIER_INVOICE_STATE', 'Uma factura validada não se anula.')
      }
      await this.invoices.setValidation(scope, id, { status: 'VOID' })
      return this.detail(scope, id)
    }, context)
  }

  /**
   * Valida a factura. Sem divergências (ou sem encomenda) fica validada e nasce o pagável, de forma idempotente.
   * Com divergências fica «em disputa» (gravado) e devolve-as; `override` (com motivo) só é aceite a quem tem a permissão de
   * excepção, verificada pelo controller, e regista a justificação.
   */
  async validate(
    context: TenantContext,
    id: string,
    override: { reason: string } | null
  ): Promise<SupplierInvoiceDetail> {
    if (override && override.reason.trim().length === 0) {
      throw failure('overrideReason', 'REQUIRED', 'Indique a justificação da excepção.')
    }
    const current = await this.get(context, id)
    if (current.status === 'VALIDATED') return current
    if (current.status === 'VOID') {
      throw ApiError.conflict('SUPPLIER_INVOICE_STATE', 'Uma factura anulada não se valida.')
    }
    if (current.lines.length === 0) {
      throw failure('lines', 'REQUIRED', 'A factura não tem linhas.')
    }
    if (/^0(\.0+)?$/.test(current.totals.total)) {
      throw failure('lines', 'ZERO_TOTAL', 'O total da factura é zero.')
    }
    const supplier = await this.references.supplier(context, current.supplierId)
    if (!supplier) throw failure('supplierId', 'UNKNOWN_SUPPLIER', 'O fornecedor não existe.')
    const purchase = current.purchaseOrderId
      ? await this.references.purchaseOrder(context, current.purchaseOrderId)
      : null

    return this.uow.run(async (scope) => {
      const locked = await this.invoices.find(scope, id, true)
      if (!locked) throw ApiError.notFound()
      if (locked.status === 'VALIDATED') return this.detail(scope, id)
      if (locked.status === 'VOID') {
        throw ApiError.conflict('SUPPLIER_INVOICE_STATE', 'Uma factura anulada não se valida.')
      }
      const lines = await this.invoices.lines(scope, id)
      let discrepancies: Discrepancy[] = []
      if (purchase) {
        const linked = lines.filter((l) => l.purchaseLineId)
        const already = await this.invoices.invoicedByPurchaseLine(
          scope,
          linked.map((l) => l.purchaseLineId as string),
          id
        )
        const match = []
        for (const line of linked) {
          const ordered = purchase.lines.find((p) => p.id === line.purchaseLineId)
          if (!ordered) {
            throw failure(
              'lines',
              'UNKNOWN_PURCHASE_LINE',
              'Uma linha não pertence à encomenda indicada.'
            )
          }
          match.push({
            invoiceLineId: line.id,
            purchaseLineId: ordered.id,
            invoicedQuantity: line.quantity,
            alreadyInvoiced: already.get(ordered.id) ?? '0',
            receivedQuantity: ordered.receivedQty,
            orderedUnitCost: ordered.unitCost,
            invoicedUnitPrice: line.unitPrice,
          })
        }
        discrepancies = matchInvoice(match)
      }
      if (discrepancies.length > 0 && !override) {
        await this.invoices.setValidation(scope, id, {
          status: 'DISPUTED',
          matching: discrepancies,
        })
        return this.detail(scope, id)
      }
      const validated = await this.invoices.setValidation(scope, id, {
        status: 'VALIDATED',
        matching: purchase ? discrepancies : null,
        overrideReason:
          discrepancies.length > 0 ? (override as { reason: string }).reason.trim() : null,
      })
      await this.obligations.insert(scope, 'payable', {
        organizationId: validated.organizationId,
        partyId: supplier.partyId,
        sourceType: 'SUPPLIER_INVOICE',
        sourceId: id,
        installmentNo: 1,
        originalAmount: validated.totals.total,
        currency: validated.currency,
        dueOn: validated.dueOn,
      })
      await this.outbox.append(scope, {
        aggregateType: 'supplier_invoice',
        aggregateId: id,
        aggregateVersion: validated.version,
        eventType: 'finance.supplier_invoice.validated',
        payload: {
          supplierInvoiceId: id,
          supplierId: validated.supplierId,
          organizationId: validated.organizationId,
          total: validated.totals.total,
          currency: validated.currency,
          overridden: discrepancies.length > 0,
        },
        correlationId: context.correlationId,
      })
      return this.detail(scope, id)
    }, context)
  }

  private assertEditable(invoice: SupplierInvoice) {
    if (invoice.status !== 'DRAFT' && invoice.status !== 'DISPUTED') {
      throw ApiError.conflict('SUPPLIER_INVOICE_STATE', 'A factura já não se pode alterar.')
    }
  }

  private duplicateNumber() {
    return ApiError.conflict(
      'SUPPLIER_INVOICE_NUMBER_EXISTS',
      'Este fornecedor já tem uma factura com este número.'
    )
  }

  private async checkPurchase(
    context: TenantContext,
    purchaseOrderId: string | null,
    supplierId: string,
    currency: string
  ) {
    if (!purchaseOrderId) return
    const order = await this.references.purchaseOrder(context, purchaseOrderId)
    if (!order)
      throw failure('purchaseOrderId', 'UNKNOWN_PURCHASE_ORDER', 'A encomenda não existe.')
    if (order.supplierId !== supplierId) {
      throw failure('purchaseOrderId', 'PURCHASE_SUPPLIER', 'A encomenda é de outro fornecedor.')
    }
    if (order.currency !== currency) {
      throw failure('currency', 'PURCHASE_CURRENCY', `A encomenda está em ${order.currency}.`)
    }
    if (order.status === 'DRAFT' || order.status === 'CANCELLED') {
      throw failure('purchaseOrderId', 'PURCHASE_STATE', 'A encomenda não está confirmada.')
    }
  }
}
