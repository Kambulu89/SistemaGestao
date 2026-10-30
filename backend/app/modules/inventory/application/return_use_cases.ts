import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { costText, fromDb, qtyText, roundDiv } from '#modules/inventory/domain/decimal'
import {
  MAX_LINES,
  normalizeReturnLine,
  RETURN_DIRECTIONS,
  returnable,
  TECHNICAL,
  type ReturnDirection,
  type ReturnLineInput,
  type ReturnStatus,
} from '#modules/inventory/domain/logistics'
import type { Issue } from '#modules/inventory/domain/stock'
import type {
  GoodsReturn,
  ReturnLine,
  ReturnStore,
  SourceLine,
} from '#modules/inventory/application/logistics_ports'
import type { References, WarehouseStore } from '#modules/inventory/application/ports'
import type { Clock, StockUseCases } from '#modules/inventory/application/stock_use_cases'
import { inventoryValidation } from '#modules/inventory/application/warehouse_use_cases'

const MAX_PAGE = 200
const fail = (path: string, code: string, message: string) =>
  inventoryValidation([{ path, code, message }])

export const RETURN_SOURCE = 'GOODS_RETURN'

export type ReturnDetail = GoodsReturn & { lines: ReturnLine[] }

export interface SourceLineView {
  sourceLineId: string
  variantId: string
  lots: { lotId: string | null; quantity: string }[]
  /** Líquido do documento de origem (expedido ou recebido, sem o que foi revertido). */
  quantity: string
  /** Já devolvido (devoluções aprovadas ou lançadas). */
  returned: string
  returnable: string
  unitCost: string
}

export interface ReturnInput {
  direction?: unknown
  sourceDocumentId?: unknown
  warehouseId?: unknown
  reason?: unknown
  lines?: ReturnLineInput[]
}

const sourceTypeOf = (direction: ReturnDirection) =>
  direction === 'CUSTOMER' ? ('SHIPMENT' as const) : ('GOODS_RECEIPT' as const)

/**
 * Devoluções (M08). Partem sempre da linha do documento de origem — a expedição (cliente) ou a recepção (fornecedor) —
 * tal como o **livro de movimentos** a conhece, e nunca excedem o líquido ainda devolvível (origem menos o já devolvido). A
 * devolução de cliente dá entrada do stock ao custo da saída original: vendável volta ao armazém, danificado e em
 * quarentena vão para armazéns técnicos (não se vendem). A devolução a fornecedor tira o stock do armazém.
 */
export class ReturnUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly returns: ReturnStore,
    private readonly warehouses: WarehouseStore,
    private readonly stock: StockUseCases,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: { direction?: ReturnDirection; status?: ReturnStatus; limit?: number; offset?: number }
  ) {
    return this.uow.run(
      (scope) =>
        this.returns.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<ReturnDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  private async detail(scope: TenantScope, id: string): Promise<ReturnDetail> {
    const found = await this.returns.find(scope, id)
    if (!found) throw ApiError.notFound()
    return { ...found, lines: await this.returns.lines(scope, id) }
  }

  /** O documento de origem com o que já foi devolvido e o que ainda se pode devolver, por linha. */
  sourceLines(
    context: TenantContext,
    direction: ReturnDirection,
    sourceDocumentId: string
  ): Promise<SourceLineView[]> {
    return this.uow.run(async (scope) => {
      const views = await this.viewsOf(scope, direction, sourceDocumentId)
      if (views.length === 0) throw ApiError.notFound()
      return views
    }, context)
  }

  private async viewsOf(
    scope: TenantScope,
    direction: ReturnDirection,
    sourceDocumentId: string,
    exceptReturnId?: string
  ): Promise<SourceLineView[]> {
    const lines = await this.returns.sourceLines(scope, sourceTypeOf(direction), sourceDocumentId)
    const returned = await this.returns.returnedBySourceLine(
      scope,
      sourceDocumentId,
      exceptReturnId
    )
    const byLine = new Map<string, SourceLine[]>()
    for (const line of lines) {
      byLine.set(line.sourceLineId, [...(byLine.get(line.sourceLineId) ?? []), line])
    }
    return [...byLine.entries()].map(([sourceLineId, parts]) => {
      const total = parts.reduce((sum, p) => sum + fromDb(p.quantity, 6), 0n)
      const value = parts.reduce(
        (sum, p) => sum + fromDb(p.quantity, 6) * fromDb(p.unitCost, 4),
        0n
      )
      const done = returned.get(sourceLineId) ?? qtyText(0n)
      return {
        sourceLineId,
        variantId: (parts[0] as SourceLine).variantId,
        lots: parts.map((p) => ({ lotId: p.lotId, quantity: p.quantity })),
        quantity: qtyText(total),
        returned: done,
        returnable: returnable(qtyText(total), done),
        unitCost: costText(total === 0n ? 0n : roundDiv(value, total)),
      }
    })
  }

  create(context: TenantContext, input: ReturnInput): Promise<ReturnDetail> {
    const issues: Issue[] = []
    if (!RETURN_DIRECTIONS.includes(input.direction as ReturnDirection)) {
      issues.push({
        path: 'direction',
        code: 'INVALID_DIRECTION',
        message: 'Sentido: CUSTOMER ou SUPPLIER.',
      })
    }
    for (const key of ['sourceDocumentId', 'warehouseId'] as const) {
      if (typeof input[key] !== 'string') {
        issues.push({ path: key, code: 'REQUIRED', message: 'Campo obrigatório.' })
      }
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (!reason || reason.length > 300) {
      issues.push({
        path: 'reason',
        code: 'REQUIRED',
        message: 'Indique o motivo (até 300 caracteres).',
      })
    }
    if ((input.lines?.length ?? 0) > MAX_LINES) {
      issues.push({ path: 'lines', code: 'TOO_MANY', message: `No máximo ${MAX_LINES} linhas.` })
    }
    const lines = (input.lines ?? []).map((l, i) => normalizeReturnLine(l, `lines[${i}]`, issues))
    if (issues.length > 0) throw inventoryValidation(issues)
    const direction = input.direction as ReturnDirection
    return this.uow.run(async (scope) => {
      const warehouse = await this.warehouses.find(scope, input.warehouseId as string)
      if (!warehouse) throw fail('warehouseId', 'UNKNOWN_WAREHOUSE', 'O armazém não existe.')
      if (!warehouse.active || warehouse.technical) {
        throw fail('warehouseId', 'WAREHOUSE_NOT_USABLE', 'O armazém está inactivo ou é técnico.')
      }
      const sources = await this.returns.sourceLines(
        scope,
        sourceTypeOf(direction),
        input.sourceDocumentId as string
      )
      if (sources.length === 0) {
        throw fail(
          'sourceDocumentId',
          'UNKNOWN_SOURCE',
          direction === 'CUSTOMER'
            ? 'A expedição não existe, não baixou stock ou foi revertida.'
            : 'A recepção não existe, não deu entrada de stock ou foi revertida.'
        )
      }
      if ((sources[0] as SourceLine).organizationId !== warehouse.organizationId) {
        throw fail('warehouseId', 'DIFFERENT_ORGANIZATION', 'O armazém é de outra organização.')
      }
      await this.returns.lockSource(scope, input.sourceDocumentId as string)
      const created = await this.returns.insert(scope, {
        organizationId: warehouse.organizationId,
        direction,
        sourceDocumentId: input.sourceDocumentId as string,
        warehouseId: warehouse.id,
        reason,
      })
      for (const line of lines) await this.insertLine(scope, created, line!)
      return this.detail(scope, created.id)
    }, context)
  }

  addLine(context: TenantContext, id: string, input: ReturnLineInput): Promise<ReturnDetail> {
    const issues: Issue[] = []
    const line = normalizeReturnLine(input, 'line', issues)
    if (!line) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const found = await this.returns.find(scope, id, true)
      if (!found) throw ApiError.notFound()
      this.requireDraft(found)
      await this.returns.lockSource(scope, found.sourceDocumentId)
      await this.insertLine(scope, found, line)
      return this.detail(scope, id)
    }, context)
  }

  private async insertLine(
    scope: TenantScope,
    found: GoodsReturn,
    line: NonNullable<ReturnType<typeof normalizeReturnLine>>
  ) {
    const views = await this.viewsOf(scope, found.direction, found.sourceDocumentId, found.id)
    const view = views.find((v) => v.sourceLineId === line.sourceLineId)
    if (!view) {
      throw fail(
        'sourceLineId',
        'UNKNOWN_SOURCE_LINE',
        'A linha não pertence ao documento de origem.'
      )
    }
    // O que já está noutras linhas deste mesmo rascunho também conta.
    const draftLines = await this.returns.lines(scope, found.id)
    const mine = draftLines
      .filter((l) => l.sourceLineId === line.sourceLineId)
      .reduce((sum, l) => sum + fromDb(l.quantity, 6), 0n)
    const left = fromDb(view.returnable, 6) - mine
    if (fromDb(line.quantity, 6) > left) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
        {
          path: 'quantity',
          code: 'EXCEEDS_RETURNABLE',
          message: `Devolvível: ${qtyText(left < 0n ? 0n : left)} (origem ${view.quantity}, já devolvido ${view.returned}).`,
        },
      ])
    }
    let lotId = line.lotId
    const lots = view.lots.map((l) => l.lotId)
    if (lotId !== null && !lots.includes(lotId)) {
      throw fail('lotId', 'UNKNOWN_LOT', 'O lote não consta do documento de origem.')
    }
    if (lotId === null && lots.some((l) => l !== null)) {
      if (lots.length > 1) throw fail('lotId', 'LOT_REQUIRED', 'Indique o lote devolvido.')
      lotId = lots[0] ?? null
    }
    if (line.locationId) {
      const locations = await this.warehouses.listLocations(scope, found.warehouseId)
      if (!locations.some((l) => l.id === line.locationId && l.active)) {
        throw fail(
          'locationId',
          'UNKNOWN_LOCATION',
          'O local não existe neste armazém ou está inactivo.'
        )
      }
    }
    await this.returns.insertLine(scope, found.id, {
      sourceLineId: line.sourceLineId,
      variantId: view.variantId,
      lotId,
      locationId: line.locationId,
      quantity: line.quantity,
      condition: line.condition,
    })
  }

  removeLine(context: TenantContext, id: string, lineId: string): Promise<ReturnDetail> {
    return this.uow.run(async (scope) => {
      const found = await this.returns.find(scope, id, true)
      if (!found) throw ApiError.notFound()
      this.requireDraft(found)
      if (!(await this.returns.removeLine(scope, id, lineId))) throw ApiError.notFound()
      return this.detail(scope, id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const found = await this.returns.find(scope, id, true)
      if (!found) throw ApiError.notFound()
      this.requireDraft(found)
      await this.returns.remove(scope, id)
    }, context)
  }

  /** Aprova: volta a conferir, sob bloqueio do documento de origem, que nada excede o devolvível. Idempotente. */
  approve(context: TenantContext, id: string): Promise<ReturnDetail> {
    return this.uow.run(async (scope) => {
      const found = await this.returns.find(scope, id, true)
      if (!found) throw ApiError.notFound()
      if (found.status !== 'DRAFT') return this.detail(scope, id)
      await this.returns.lockSource(scope, found.sourceDocumentId)
      const lines = await this.returns.lines(scope, id)
      if (lines.length === 0) {
        throw ApiError.conflict('RETURN_EMPTY', 'Uma devolução sem linhas não se aprova.')
      }
      const views = await this.viewsOf(scope, found.direction, found.sourceDocumentId, id)
      const wanted = new Map<string, bigint>()
      for (const l of lines) {
        wanted.set(l.sourceLineId, (wanted.get(l.sourceLineId) ?? 0n) + fromDb(l.quantity, 6))
      }
      const details = [...wanted].flatMap(([sourceLineId, quantity]) => {
        const view = views.find((v) => v.sourceLineId === sourceLineId)
        return !view || quantity > fromDb(view.returnable, 6)
          ? [
              {
                path: `lines.${sourceLineId}`,
                code: 'EXCEEDS_RETURNABLE',
                message: `Devolvível: ${view?.returnable ?? qtyText(0n)}.`,
              },
            ]
          : []
      })
      if (details.length > 0) {
        throw new ApiError(
          409,
          'RETURN_NOT_APPROVABLE',
          'A devolução excede o que ainda se pode devolver.',
          details
        )
      }
      await this.returns.setStatus(scope, id, { status: 'APPROVED' })
      return this.detail(scope, id)
    }, context)
  }

  /** Lança os movimentos de stock da devolução aprovada. Idempotente. */
  post(context: TenantContext, id: string): Promise<ReturnDetail> {
    return this.uow.run(async (scope) => {
      const found = await this.returns.find(scope, id, true)
      if (!found) throw ApiError.notFound()
      if (found.status === 'POSTED') return this.detail(scope, id)
      if (found.status !== 'APPROVED') {
        throw ApiError.conflict('RETURN_NOT_APPROVED', 'Só se lança uma devolução aprovada.')
      }
      await this.returns.lockSource(scope, found.sourceDocumentId)
      const views = await this.viewsOf(scope, found.direction, found.sourceDocumentId, id)
      const sources = await this.returns.sourceLines(
        scope,
        sourceTypeOf(found.direction),
        found.sourceDocumentId
      )
      const lines = [...(await this.returns.lines(scope, id))].sort((a, b) =>
        a.variantId === b.variantId ? (a.id < b.id ? -1 : 1) : a.variantId < b.variantId ? -1 : 1
      )
      const locations = await this.warehouses.listLocations(scope, found.warehouseId)
      const firstActive = locations.find((l) => l.active)?.id ?? null
      for (const line of lines) {
        const view = views.find((v) => v.sourceLineId === line.sourceLineId)
        const exact = sources.find(
          (s) => s.sourceLineId === line.sourceLineId && s.lotId === line.lotId
        )
        const cost = exact?.unitCost ?? view?.unitCost ?? costText(0n)
        const source = { type: RETURN_SOURCE, id, lineId: line.id }
        if (found.direction === 'SUPPLIER') {
          const locationId = line.locationId ?? firstActive
          if (!locationId) {
            throw ApiError.conflict('NO_LOCATION', 'O armazém não tem nenhum local activo.')
          }
          await this.stock.postInScope(scope, {
            kind: 'ISSUE',
            variantId: line.variantId,
            locationId,
            lotId: line.lotId,
            quantityDelta: qtyText(-fromDb(line.quantity, 6)),
            source: { ...source, effect: 'OUT' },
          })
          continue
        }
        let locationId: string | null
        if (line.condition === 'SELLABLE') {
          locationId = line.locationId ?? firstActive
        } else {
          const technical = line.condition === 'DAMAGED' ? TECHNICAL.damaged : TECHNICAL.quarantine
          const place = await this.warehouses.ensureTechnical(
            scope,
            found.organizationId,
            technical.warehouse,
            technical.location
          )
          locationId = place.locationId
        }
        if (!locationId) {
          throw ApiError.conflict('NO_LOCATION', 'O armazém não tem nenhum local activo.')
        }
        await this.stock.postInScope(scope, {
          kind: 'RECEIPT',
          variantId: line.variantId,
          locationId,
          lotId: line.lotId,
          quantityDelta: line.quantity,
          unitCost: cost,
          source: { ...source, effect: 'IN' },
        })
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: found.organizationId,
        documentType: 'GOODS_RETURN',
        date: this.clock.now(),
      })
      const after = await this.returns.setStatus(scope, id, { status: 'POSTED', number })
      await this.outbox.append(scope, {
        aggregateType: 'goods_return',
        aggregateId: id,
        aggregateVersion: after.version,
        eventType: 'inventory.goods_return.posted',
        payload: {
          goodsReturnId: id,
          number,
          direction: found.direction,
          sourceDocumentId: found.sourceDocumentId,
          organizationId: found.organizationId,
        },
        correlationId: context.correlationId,
      })
      return this.detail(scope, id)
    }, context)
  }

  private requireDraft(found: GoodsReturn) {
    if (found.status !== 'DRAFT') {
      throw ApiError.conflict(
        'RETURN_NOT_DRAFT',
        'Só uma devolução em rascunho se altera ou apaga.'
      )
    }
  }
}
