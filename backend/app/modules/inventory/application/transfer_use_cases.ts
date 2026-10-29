import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { fromDb, qtyText } from '#modules/inventory/domain/decimal'
import {
  inTransit,
  MAX_LINES,
  normalizeTransferLine,
  positiveQty,
  statusAfterReceiving,
  TECHNICAL,
  type TransferLineInput,
  type TransferStatus,
} from '#modules/inventory/domain/logistics'
import type { Issue } from '#modules/inventory/domain/stock'
import type {
  Transfer,
  TransferLine,
  TransferReceipt,
  TransferStore,
} from '#modules/inventory/application/logistics_ports'
import type { References, WarehouseStore } from '#modules/inventory/application/ports'
import type { Clock, StockUseCases } from '#modules/inventory/application/stock_use_cases'
import { inventoryValidation } from '#modules/inventory/application/warehouse_use_cases'

const MAX_PAGE = 200
const fail = (path: string, code: string, message: string) =>
  inventoryValidation([{ path, code, message }])

export const TRANSFER_SOURCE = 'STOCK_TRANSFER'
export const TRANSFER_RECEIPT_SOURCE = 'TRANSFER_RECEIPT'

export type TransferDetail = Transfer & {
  lines: (TransferLine & { inTransit: string })[]
  receipts: TransferReceipt[]
}

export interface TransferInput {
  sourceWarehouseId?: unknown
  destinationWarehouseId?: unknown
  notes?: unknown
  lines?: TransferLineInput[]
}

const negative = (quantity: string) => qtyText(-fromDb(quantity, 6))

/**
 * Transferências entre armazéns da mesma organização (M08). Expedir tira da origem e coloca o stock numa localização
 * técnica «em trânsito»; receber tira de trânsito e entra no destino, por receitas parciais se for preciso. O stock nunca
 * está em dois sítios: cada passo é um par de movimentos na mesma transacção. O que falta receber continua em trânsito
 * (pendente de resolução), nunca desaparece.
 */
export class TransferUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly transfers: TransferStore,
    private readonly warehouses: WarehouseStore,
    private readonly stock: StockUseCases,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: { status?: TransferStatus; warehouseId?: string; limit?: number; offset?: number }
  ) {
    return this.uow.run(
      (scope) =>
        this.transfers.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<TransferDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  private async detail(scope: TenantScope, id: string): Promise<TransferDetail> {
    const transfer = await this.transfers.find(scope, id)
    if (!transfer) throw ApiError.notFound()
    const lines = await this.transfers.lines(scope, id)
    return {
      ...transfer,
      lines: lines.map((l) => ({ ...l, inTransit: inTransit(l.dispatchedQty, l.receivedQty) })),
      receipts: await this.transfers.receipts(scope, id),
    }
  }

  create(context: TenantContext, input: TransferInput): Promise<TransferDetail> {
    const issues: Issue[] = []
    if (typeof input.sourceWarehouseId !== 'string') {
      issues.push({
        path: 'sourceWarehouseId',
        code: 'REQUIRED',
        message: 'Indique o armazém de origem.',
      })
    }
    if (typeof input.destinationWarehouseId !== 'string') {
      issues.push({
        path: 'destinationWarehouseId',
        code: 'REQUIRED',
        message: 'Indique o armazém de destino.',
      })
    }
    if (
      input.notes !== undefined &&
      input.notes !== null &&
      (typeof input.notes !== 'string' || input.notes.length > 1000)
    ) {
      issues.push({ path: 'notes', code: 'INVALID_TEXT', message: 'Notas: até 1000 caracteres.' })
    }
    if ((input.lines?.length ?? 0) > MAX_LINES) {
      issues.push({ path: 'lines', code: 'TOO_MANY', message: `No máximo ${MAX_LINES} linhas.` })
    }
    const lines = (input.lines ?? []).map((l, i) => normalizeTransferLine(l, `lines[${i}]`, issues))
    if (issues.length > 0) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const source = await this.warehouses.find(scope, input.sourceWarehouseId as string)
      const destination = await this.warehouses.find(scope, input.destinationWarehouseId as string)
      if (!source)
        throw fail('sourceWarehouseId', 'UNKNOWN_WAREHOUSE', 'O armazém de origem não existe.')
      if (!destination) {
        throw fail(
          'destinationWarehouseId',
          'UNKNOWN_WAREHOUSE',
          'O armazém de destino não existe.'
        )
      }
      if (source.id === destination.id) {
        throw fail(
          'destinationWarehouseId',
          'SAME_WAREHOUSE',
          'Origem e destino têm de ser diferentes.'
        )
      }
      if (source.organizationId !== destination.organizationId) {
        throw fail(
          'destinationWarehouseId',
          'DIFFERENT_ORGANIZATION',
          'Entre organizações usa-se o processo intercompany, não uma transferência.'
        )
      }
      for (const [path, warehouse] of [
        ['sourceWarehouseId', source],
        ['destinationWarehouseId', destination],
      ] as const) {
        if (!warehouse.active || warehouse.technical) {
          throw fail(path, 'WAREHOUSE_NOT_USABLE', 'O armazém está inactivo ou é técnico.')
        }
      }
      const created = await this.transfers.insert(scope, {
        organizationId: source.organizationId,
        sourceWarehouseId: source.id,
        destinationWarehouseId: destination.id,
        notes: ((input.notes as string | null | undefined) ?? null) || null,
      })
      for (const line of lines) await this.insertLine(scope, created, line!)
      return this.detail(scope, created.id)
    }, context)
  }

  updateNotes(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; notes: string | null }
  ): Promise<TransferDetail> {
    return this.uow.run(async (scope) => {
      const current = await this.transfers.find(scope, id, true)
      if (!current) throw ApiError.notFound()
      this.requireDraft(current)
      await this.transfers.updateNotes(scope, id, input.expectedVersion, input.notes)
      return this.detail(scope, id)
    }, context)
  }

  addLine(context: TenantContext, id: string, input: TransferLineInput): Promise<TransferDetail> {
    const issues: Issue[] = []
    const line = normalizeTransferLine(input, 'line', issues)
    if (!line) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const transfer = await this.transfers.find(scope, id, true)
      if (!transfer) throw ApiError.notFound()
      this.requireDraft(transfer)
      const existing = await this.transfers.lines(scope, id)
      if (existing.length >= MAX_LINES) {
        throw fail('lines', 'TOO_MANY', `No máximo ${MAX_LINES} linhas.`)
      }
      await this.insertLine(scope, transfer, line)
      return this.detail(scope, id)
    }, context)
  }

  private async insertLine(
    scope: TenantScope,
    transfer: Transfer,
    line: ReturnType<typeof normalizeTransferLine> & object
  ) {
    const variant = await this.references.variant(scope.context, line.variantId)
    if (!variant || !variant.active || !variant.product.trackStock) {
      throw fail(
        'variantId',
        'UNKNOWN_VARIANT',
        'A variante não existe, está inactiva ou não tem controlo de stock.'
      )
    }
    if (variant.product.trackingMode === 'NONE' && line.lotId) {
      throw fail('lotId', 'LOT_NOT_ALLOWED', 'Este produto não tem rastreio por lote.')
    }
    if (variant.product.trackingMode !== 'NONE' && !line.lotId) {
      throw fail('lotId', 'LOT_REQUIRED', 'Indique o lote.')
    }
    const resolve = async (warehouseId: string, given: string | null, path: string) => {
      const locations = await this.warehouses.listLocations(scope, warehouseId)
      const chosen = given ? locations.find((l) => l.id === given) : locations.find((l) => l.active)
      if (!chosen || !chosen.active) {
        throw fail(path, 'UNKNOWN_LOCATION', 'O local não existe neste armazém ou está inactivo.')
      }
      return chosen.id
    }
    await this.transfers.insertLine(scope, transfer.id, {
      variantId: line.variantId,
      lotId: line.lotId,
      sourceLocationId: await resolve(
        transfer.sourceWarehouseId,
        line.sourceLocationId,
        'sourceLocationId'
      ),
      destinationLocationId: await resolve(
        transfer.destinationWarehouseId,
        line.destinationLocationId,
        'destinationLocationId'
      ),
      quantity: line.quantity,
    })
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<TransferDetail> {
    return this.uow.run(async (scope) => {
      const transfer = await this.transfers.find(scope, id, true)
      if (!transfer) throw ApiError.notFound()
      this.requireDraft(transfer)
      if (!(await this.transfers.removeLine(scope, id, lineId))) throw ApiError.notFound()
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const transfer = await this.transfers.find(scope, id, true)
      if (!transfer) throw ApiError.notFound()
      this.requireDraft(transfer)
      await this.transfers.remove(scope, id)
    }, context)
  }

  cancel(context: TenantContext, id: string, reason: string): Promise<TransferDetail> {
    const text = reason.trim()
    if (!text) throw fail('reason', 'REQUIRED', 'Indique o motivo.')
    return this.uow.run(async (scope) => {
      const transfer = await this.transfers.find(scope, id, true)
      if (!transfer) throw ApiError.notFound()
      if (transfer.status === 'CANCELLED') return this.detail(scope, id)
      if (transfer.status !== 'DRAFT') {
        throw ApiError.conflict(
          'TRANSFER_NOT_CANCELLABLE',
          'Depois de expedida a transferência já não se cancela: receba o que está em trânsito.'
        )
      }
      await this.transfers.setStatus(scope, id, { status: 'CANCELLED', reason: text })
      return this.detail(scope, id)
    }, context)
  }

  /** Expede: tira da origem e põe em trânsito, tudo na mesma transacção. Idempotente. */
  dispatch(context: TenantContext, id: string): Promise<TransferDetail> {
    return this.uow.run(async (scope) => {
      const transfer = await this.transfers.find(scope, id, true)
      if (!transfer) throw ApiError.notFound()
      if (transfer.status !== 'DRAFT') {
        if (transfer.status === 'CANCELLED') {
          throw ApiError.conflict('TRANSFER_CANCELLED', 'A transferência foi cancelada.')
        }
        return this.detail(scope, id)
      }
      const lines = await this.transfers.lines(scope, id)
      if (lines.length === 0) {
        throw ApiError.conflict('TRANSFER_EMPTY', 'Uma transferência sem linhas não se expede.')
      }
      const transit = await this.warehouses.ensureTechnical(
        scope,
        transfer.organizationId,
        TECHNICAL.transit.warehouse,
        TECHNICAL.transit.location
      )
      // Sempre pela mesma ordem (variante, depois linha) para os bloqueios nunca se cruzarem entre transferências.
      const ordered = [...lines].sort((a, b) =>
        a.variantId === b.variantId ? (a.id < b.id ? -1 : 1) : a.variantId < b.variantId ? -1 : 1
      )
      for (const line of ordered) {
        const out = await this.stock.postInScope(scope, {
          kind: 'TRANSFER_OUT',
          variantId: line.variantId,
          locationId: line.sourceLocationId,
          lotId: line.lotId,
          quantityDelta: negative(line.quantity),
          source: { type: TRANSFER_SOURCE, id, lineId: line.id, effect: 'OUT' },
        })
        await this.stock.postInScope(scope, {
          kind: 'TRANSFER_IN',
          variantId: line.variantId,
          locationId: transit.locationId,
          lotId: line.lotId,
          quantityDelta: line.quantity,
          unitCost: out.movement.unitCost,
          source: { type: TRANSFER_SOURCE, id, lineId: line.id, effect: 'TRANSIT' },
        })
        await this.transfers.markDispatched(scope, line.id, line.quantity)
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: transfer.organizationId,
        documentType: 'STOCK_TRANSFER',
        date: this.clock.now(),
      })
      const after = await this.transfers.setStatus(scope, id, { status: 'DISPATCHED', number })
      await this.outbox.append(scope, {
        aggregateType: 'stock_transfer',
        aggregateId: id,
        aggregateVersion: after.version,
        eventType: 'inventory.transfer.dispatched',
        payload: { transferId: id, number, organizationId: transfer.organizationId },
        correlationId: context.correlationId,
      })
      return this.detail(scope, id)
    }, context)
  }

  /**
   * Recebe (parte de) o que está em trânsito. Cada recepção é um registo só-de-acrescentar; com `idempotencyKey`, repetir o
   * pedido devolve o resultado em vez de receber outra vez. Nunca se recebe mais do que o que está em trânsito.
   */
  receive(
    context: TenantContext,
    id: string,
    input: { lines: { lineId: string; quantity: string }[] },
    idempotencyKey: string | null
  ): Promise<TransferDetail> {
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw fail('lines', 'REQUIRED', 'Indique pelo menos uma linha a receber.')
    }
    const wanted = new Map<string, bigint>()
    const issues: Issue[] = []
    input.lines.forEach((l, i) => {
      const quantity = positiveQty(l.quantity)
      if (quantity === null) {
        issues.push({
          path: `lines[${i}].quantity`,
          code: 'INVALID_QUANTITY',
          message: 'Quantidade positiva com até 6 casas.',
        })
      } else if (wanted.has(l.lineId)) {
        issues.push({ path: `lines[${i}].lineId`, code: 'DUPLICATE', message: 'Linha repetida.' })
      } else {
        wanted.set(l.lineId, quantity)
      }
    })
    if (issues.length > 0) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const transfer = await this.transfers.find(scope, id, true)
      if (!transfer) throw ApiError.notFound()
      if (idempotencyKey) {
        const existing = await this.transfers.findReceiptByKey(scope, id, idempotencyKey)
        if (existing) return this.detail(scope, id)
      }
      if (transfer.status !== 'DISPATCHED' && transfer.status !== 'PARTIAL_RECEIVED') {
        throw ApiError.conflict(
          'TRANSFER_NOT_RECEIVABLE',
          'Só se recebe uma transferência expedida que ainda tenha stock em trânsito.'
        )
      }
      const lines = await this.transfers.lines(scope, id)
      const chosen: { line: TransferLine; quantity: bigint }[] = []
      for (const [lineId, quantity] of wanted) {
        const line = lines.find((l) => l.id === lineId)
        if (!line)
          throw fail('lines', 'UNKNOWN_LINE', 'Uma linha não pertence a esta transferência.')
        if (quantity > fromDb(inTransit(line.dispatchedQty, line.receivedQty), 6)) {
          throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
            {
              path: `lines.${lineId}`,
              code: 'EXCEEDS_IN_TRANSIT',
              message: `Em trânsito: ${inTransit(line.dispatchedQty, line.receivedQty)}.`,
            },
          ])
        }
        chosen.push({ line, quantity })
      }
      chosen.sort((a, b) =>
        a.line.variantId === b.line.variantId
          ? a.line.id < b.line.id
            ? -1
            : 1
          : a.line.variantId < b.line.variantId
            ? -1
            : 1
      )
      const transit = await this.warehouses.ensureTechnical(
        scope,
        transfer.organizationId,
        TECHNICAL.transit.warehouse,
        TECHNICAL.transit.location
      )
      const receipt = await this.transfers.insertReceipt(
        scope,
        id,
        idempotencyKey,
        chosen.map((c) => ({ transferLineId: c.line.id, quantity: qtyText(c.quantity) }))
      )
      for (const { line, quantity } of chosen) {
        const text = qtyText(quantity)
        const out = await this.stock.postInScope(scope, {
          kind: 'TRANSFER_OUT',
          variantId: line.variantId,
          locationId: transit.locationId,
          lotId: line.lotId,
          quantityDelta: negative(text),
          source: { type: TRANSFER_RECEIPT_SOURCE, id: receipt.id, lineId: line.id, effect: 'OUT' },
        })
        await this.stock.postInScope(scope, {
          kind: 'TRANSFER_IN',
          variantId: line.variantId,
          locationId: line.destinationLocationId,
          lotId: line.lotId,
          quantityDelta: text,
          unitCost: out.movement.unitCost,
          source: { type: TRANSFER_RECEIPT_SOURCE, id: receipt.id, lineId: line.id, effect: 'IN' },
        })
        await this.transfers.addReceived(scope, line.id, text)
      }
      const status = statusAfterReceiving(await this.transfers.lines(scope, id))
      const after = await this.transfers.setStatus(scope, id, { status })
      await this.outbox.append(scope, {
        aggregateType: 'stock_transfer',
        aggregateId: id,
        aggregateVersion: after.version,
        eventType: 'inventory.transfer.received',
        payload: { transferId: id, receiptId: receipt.id, status },
        correlationId: context.correlationId,
      })
      return this.detail(scope, id)
    }, context)
  }

  private requireDraft(transfer: Transfer) {
    if (transfer.status !== 'DRAFT') {
      throw ApiError.conflict(
        'TRANSFER_NOT_DRAFT',
        'Só uma transferência em rascunho se altera ou apaga.'
      )
    }
  }
}
