import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { toScaled } from '#modules/procurement/domain/decimal'
import {
  canReceive,
  fits,
  normalizeReceiptLine,
  quantityText,
  remaining,
  statusAfterReceiving,
  type Balance,
  type Issue,
  type ReceiptLineInput,
  type ReceiptStatus,
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
  Receipt,
  ReceiptLine,
  ReceiptStore,
  References,
} from '#modules/procurement/application/ports'
import {
  runPostedEffects,
  runReversedEffects,
  type ReceiptLineRef,
} from '#modules/procurement/application/registry'

export type ReceiptDetail = Receipt & { lines: ReceiptLine[] }

export interface ReceiptInput {
  purchaseOrderId?: string
  warehouseId?: string | null
  supplierDocument?: string | null
  notes?: string | null
  lines?: ReceiptLineInput[]
}

/**
 * Recepções (M06): entregam parte (ou a totalidade) de uma encomenda confirmada. Lançar numera, dá entrada do stock **na
 * mesma transacção** (efeitos registados pelo inventário, ao custo da linha) e actualiza o estado da encomenda; reverter
 * tira o stock e reabre o saldo. O saldo de cada linha confere-se sob bloqueio da encomenda, por isso duas recepções
 * concorrentes nunca recebem mais do que foi encomendado.
 */
export class ReceiptUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly receipts: ReceiptStore,
    private readonly purchases: PurchaseStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: { purchaseOrderId?: string; status?: ReceiptStatus; limit?: number; offset?: number }
  ) {
    return this.uow.run(
      (scope) =>
        this.receipts.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<ReceiptDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  async create(context: TenantContext, input: ReceiptInput): Promise<ReceiptDetail> {
    const header = this.header(input)
    if (typeof input.purchaseOrderId !== 'string' || !input.purchaseOrderId) {
      throw failure('purchaseOrderId', 'REQUIRED', 'Indique a encomenda.')
    }
    if ((input.lines?.length ?? 0) > MAX_LINES) {
      throw failure('lines', 'TOO_MANY', `No máximo ${MAX_LINES} linhas.`)
    }
    return this.uow.run(async (scope) => {
      const order = await this.purchases.find(scope, input.purchaseOrderId as string)
      if (!order) throw ApiError.notFound()
      this.assertReceivable(order)
      await this.assertWarehouse(context, header.warehouseId, order.organizationId)
      const created = await this.receipts.insert(scope, {
        organizationId: order.organizationId,
        purchaseOrderId: order.id,
        ...header,
      })
      for (const [index, raw] of (input.lines ?? []).entries()) {
        await this.addLineInScope(scope, created, order, raw, `lines[${index}].`)
      }
      return this.detail(scope, created.id)
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: ReceiptInput & { expectedVersion: number }
  ): Promise<ReceiptDetail> {
    const header = this.header(input)
    return this.uow.run(async (scope) => {
      const current = await this.requireDraft(scope, id)
      const next = {
        warehouseId: input.warehouseId === undefined ? current.warehouseId : header.warehouseId,
        supplierDocument:
          input.supplierDocument === undefined ? current.supplierDocument : header.supplierDocument,
        notes: input.notes === undefined ? current.notes : header.notes,
      }
      await this.assertWarehouse(context, next.warehouseId, current.organizationId)
      await this.receipts.updateHeader(scope, id, input.expectedVersion, next)
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      await this.receipts.remove(scope, id)
    }, context)
  }

  addLine(context: TenantContext, id: string, input: ReceiptLineInput): Promise<ReceiptDetail> {
    return this.uow.run(async (scope) => {
      const receipt = await this.requireDraft(scope, id)
      const order = (await this.purchases.find(scope, receipt.purchaseOrderId)) as PurchaseOrder
      this.assertReceivable(order)
      await this.addLineInScope(scope, receipt, order, input, '')
      return this.detail(scope, id)
    }, context)
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<ReceiptDetail> {
    return this.uow.run(async (scope) => {
      await this.requireDraft(scope, id)
      if (!(await this.receipts.findLine(scope, id, lineId))) throw ApiError.notFound()
      await this.receipts.removeLine(scope, lineId)
      return this.detail(scope, id)
    }, context)
  }

  /** Lança a recepção: confere o saldo sob bloqueio da encomenda, numera e dá entrada do stock. Idempotente. */
  post(
    context: TenantContext,
    id: string
  ): Promise<{ receipt: ReceiptDetail; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const probe = await this.receipts.find(scope, id)
      if (!probe) throw ApiError.notFound()
      // Primeiro a encomenda (bloqueio comum a todas as suas recepções), depois a recepção.
      await this.purchases.lock(scope, probe.purchaseOrderId)
      const receipt = (await this.receipts.find(scope, id, true)) as Receipt
      if (receipt.status === 'POSTED')
        return { receipt: await this.detail(scope, id), idempotent: true }
      if (receipt.status === 'REVERSED') {
        throw ApiError.conflict('GOODS_RECEIPT_REVERSED', 'A recepção já foi revertida.')
      }
      const order = (await this.purchases.find(
        scope,
        receipt.purchaseOrderId,
        true
      )) as PurchaseOrder
      this.assertReceivable(order)
      const lines = await this.receipts.listLines(scope, id)
      if (lines.length === 0) {
        throw ApiError.conflict('GOODS_RECEIPT_EMPTY', 'Uma recepção sem linhas não se lança.')
      }
      const orderLines = await this.purchases.listLines(scope, order.id)
      const received = await this.receipts.receivedByLine(scope, order.id)
      const problems: Issue[] = []
      for (const [index, line] of lines.entries()) {
        const balance = this.balanceOf(orderLines, received, line.purchaseLineId)
        if (!balance || !fits(balance, line.quantity)) {
          problems.push({
            path: `lines[${index}].quantity`,
            code: 'EXCEEDS_BALANCE',
            message: `Só falta receber ${quantityText(balance ? remaining(balance) : 0n)}.`,
          })
        }
      }
      if (problems.length > 0) {
        throw new ApiError(
          409,
          'GOODS_RECEIPT_NOT_POSTABLE',
          'A recepção não pode ser lançada.',
          problems
        )
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: order.organizationId,
        documentType: 'GOODS_RECEIPT',
        date: this.clock.now(),
      })
      const posted = await this.receipts.post(scope, id, number)
      // A entrada de stock (e afins): um erro aqui anula o lançamento por inteiro.
      await runPostedEffects(scope, posted, order, this.refsOf(lines, orderLines))
      const after = await this.refreshOrder(scope, order, orderLines)
      await this.outbox.append(scope, {
        aggregateType: 'goods_receipt',
        aggregateId: id,
        aggregateVersion: posted.version,
        eventType: 'procurement.goods_receipt.posted',
        payload: {
          goodsReceiptId: id,
          number,
          purchaseOrderId: order.id,
          orderStatus: after.status,
          organizationId: order.organizationId,
          lines: lines.map((l) => ({
            lineId: l.id,
            purchaseLineId: l.purchaseLineId,
            quantity: l.quantity,
          })),
        },
        correlationId: context.correlationId,
      })
      return { receipt: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  /** Reverte uma recepção lançada, com motivo: tira o stock e reabre o saldo (falha se o stock já foi consumido). */
  reverse(
    context: TenantContext,
    id: string,
    reason: unknown
  ): Promise<{ receipt: ReceiptDetail; idempotent: boolean }> {
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text || text.length > 300) {
      throw failure('reason', 'REASON_REQUIRED', 'Indique o motivo (até 300 caracteres).')
    }
    return this.uow.run(async (scope) => {
      const probe = await this.receipts.find(scope, id)
      if (!probe) throw ApiError.notFound()
      await this.purchases.lock(scope, probe.purchaseOrderId)
      const receipt = (await this.receipts.find(scope, id, true)) as Receipt
      if (receipt.status === 'REVERSED') {
        return { receipt: await this.detail(scope, id), idempotent: true }
      }
      if (receipt.status !== 'POSTED') {
        throw ApiError.conflict('GOODS_RECEIPT_NOT_POSTED', 'Só uma recepção lançada se reverte.')
      }
      const order = (await this.purchases.find(
        scope,
        receipt.purchaseOrderId,
        true
      )) as PurchaseOrder
      const lines = await this.receipts.listLines(scope, id)
      const orderLines = await this.purchases.listLines(scope, order.id)
      const reversed = await this.receipts.reverse(scope, id, text)
      await runReversedEffects(scope, reversed, order, this.refsOf(lines, orderLines))
      const after = await this.refreshOrder(scope, order, orderLines)
      await this.outbox.append(scope, {
        aggregateType: 'goods_receipt',
        aggregateId: id,
        aggregateVersion: reversed.version,
        eventType: 'procurement.goods_receipt.reversed',
        payload: {
          goodsReceiptId: id,
          number: receipt.number,
          purchaseOrderId: order.id,
          orderStatus: after.status,
          reason: text,
        },
        correlationId: context.correlationId,
      })
      return { receipt: await this.detail(scope, id), idempotent: false }
    }, context)
  }

  // --- auxiliares ----------------------------------------------------------------------------

  private header(input: {
    warehouseId?: string | null
    supplierDocument?: string | null
    notes?: string | null
  }) {
    const issues: Issue[] = []
    const supplierDocument =
      typeof input.supplierDocument === 'string' ? input.supplierDocument.trim() || null : null
    if (supplierDocument && supplierDocument.length > 100) {
      issues.push({
        path: 'supplierDocument',
        code: 'TOO_LONG',
        message: 'O documento do fornecedor tem no máximo 100 caracteres.',
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
    return { warehouseId: input.warehouseId ?? null, supplierDocument, notes }
  }

  private async assertWarehouse(
    context: TenantContext,
    warehouseId: string | null,
    organizationId: string
  ): Promise<void> {
    if (
      warehouseId &&
      !(await this.references.warehouseUsable(context, warehouseId, organizationId))
    ) {
      throw failure('warehouseId', 'UNKNOWN_WAREHOUSE', 'O armazém não existe nesta organização.')
    }
  }

  private async detail(scope: TenantScope, id: string): Promise<ReceiptDetail> {
    const receipt = await this.receipts.find(scope, id)
    if (!receipt) throw ApiError.notFound()
    return { ...receipt, lines: await this.receipts.listLines(scope, id) }
  }

  private async requireDraft(scope: TenantScope, id: string): Promise<Receipt> {
    const receipt = await this.receipts.find(scope, id, true)
    if (!receipt) throw ApiError.notFound()
    if (receipt.status !== 'DRAFT') {
      throw ApiError.conflict(
        'GOODS_RECEIPT_NOT_DRAFT',
        'Só uma recepção em rascunho se altera ou apaga.'
      )
    }
    return receipt
  }

  private assertReceivable(order: PurchaseOrder): void {
    if (!canReceive(order.status)) {
      throw ApiError.conflict(
        'PURCHASE_ORDER_NOT_RECEIVABLE',
        order.status === 'RECEIVED'
          ? 'A encomenda já foi toda recebida.'
          : 'Só se recebe uma encomenda confirmada.'
      )
    }
  }

  private balanceOf(
    orderLines: readonly PurchaseLine[],
    received: ReadonlyMap<string, string>,
    purchaseLineId: string
  ): Balance | null {
    const line = orderLines.find((l) => l.id === purchaseLineId)
    if (!line) return null
    return {
      ordered: toScaled(line.quantity, 6) ?? 0n,
      received: toScaled(received.get(purchaseLineId) ?? '0', 6) ?? 0n,
    }
  }

  private refsOf(
    lines: readonly ReceiptLine[],
    orderLines: readonly PurchaseLine[]
  ): ReceiptLineRef[] {
    return lines.map((l) => {
      const target = orderLines.find((o) => o.id === l.purchaseLineId) as PurchaseLine
      return {
        id: l.id,
        purchaseLineId: l.purchaseLineId,
        variantId: target.variantId,
        quantity: l.quantity,
        unitCost: target.unitCost,
        lotCode: l.lotCode,
        expiresOn: l.expiresOn,
      }
    })
  }

  /** Recalcula o estado da encomenda a partir das recepções lançadas e não revertidas. */
  private async refreshOrder(
    scope: TenantScope,
    order: PurchaseOrder,
    orderLines: readonly PurchaseLine[]
  ) {
    const received = await this.receipts.receivedByLine(scope, order.id)
    const status = statusAfterReceiving(
      orderLines.map((l) => this.balanceOf(orderLines, received, l.id) as Balance)
    )
    return this.purchases.setStatus(scope, order.id, status)
  }

  private async addLineInScope(
    scope: TenantScope,
    receipt: Receipt,
    order: PurchaseOrder,
    raw: ReceiptLineInput,
    path: string
  ): Promise<void> {
    const issues: Issue[] = []
    const values = normalizeReceiptLine(raw, path, issues)
    if (!values) throw procurementValidation(issues)
    const orderLines = await this.purchases.listLines(scope, order.id)
    const balance = this.balanceOf(
      orderLines,
      await this.receipts.receivedByLine(scope, order.id),
      values.purchaseLineId
    )
    if (!balance) {
      throw failure(
        `${path}purchaseLineId`,
        'UNKNOWN_PURCHASE_LINE',
        'A linha não pertence a esta encomenda.'
      )
    }
    if (!fits(balance, values.quantity)) {
      throw failure(
        `${path}quantity`,
        'EXCEEDS_BALANCE',
        `Só falta receber ${quantityText(remaining(balance))}.`
      )
    }
    const created = await this.receipts.insertLine(scope, receipt.id, values)
    if (!created) {
      throw ApiError.conflict(
        'GOODS_RECEIPT_LINE_DUPLICATE',
        'Esta linha da encomenda já está na recepção: remova-a para a refazer.'
      )
    }
  }
}
