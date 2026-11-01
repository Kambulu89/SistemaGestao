import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import { fromDb, parseQty, qtyText } from '#modules/inventory/domain/decimal'
import { MAX_LINES, variance, type CountStatus } from '#modules/inventory/domain/logistics'
import type { Issue } from '#modules/inventory/domain/stock'
import type { Count, CountLine, CountStore } from '#modules/inventory/application/logistics_ports'
import type { References, WarehouseStore } from '#modules/inventory/application/ports'
import type { Clock, StockUseCases } from '#modules/inventory/application/stock_use_cases'
import { inventoryValidation } from '#modules/inventory/application/warehouse_use_cases'

const MAX_PAGE = 200
const fail = (path: string, code: string, message: string) =>
  inventoryValidation([{ path, code, message }])

export const COUNT_SOURCE = 'STOCK_COUNT'

/** Na contagem cega o esperado não se mostra enquanto se conta (só na revisão). */
export type CountLineView = Omit<CountLine, 'expectedQty' | 'varianceQty'> & {
  expectedQty: string | null
  varianceQty: string | null
}
export type CountDetail = Count & { lines: CountLineView[] }

/**
 * Contagens físicas (M08). Abrir congela os locais incluídos (nenhum movimento os toca, a não ser os ajustes da própria
 * contagem), fotografa o esperado e deixa contar (contagem cega opcional) e reconferir. Lançar gera **um ajuste por
 * diferença**, com origem única: lançar duas vezes nunca repete o ajuste. Só depois se descongela.
 */
export class CountUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly counts: CountStore,
    private readonly warehouses: WarehouseStore,
    private readonly stock: StockUseCases,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: { status?: CountStatus; warehouseId?: string; limit?: number; offset?: number }
  ) {
    return this.uow.run(
      (scope) =>
        this.counts.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<CountDetail> {
    return this.uow.run((scope) => this.detail(scope, id), context)
  }

  private async detail(scope: TenantScope, id: string): Promise<CountDetail> {
    const count = await this.counts.find(scope, id)
    if (!count) throw ApiError.notFound()
    const hide = count.blind && count.status === 'OPEN'
    const lines = await this.counts.lines(scope, id)
    return {
      ...count,
      lines: lines.map((l) => ({
        ...l,
        expectedQty: hide ? null : l.expectedQty,
        varianceQty: hide ? null : l.varianceQty,
      })),
    }
  }

  create(
    context: TenantContext,
    input: { warehouseId?: unknown; locationIds?: unknown; blind?: unknown; notes?: unknown }
  ): Promise<CountDetail> {
    const issues: Issue[] = []
    if (typeof input.warehouseId !== 'string') {
      issues.push({ path: 'warehouseId', code: 'REQUIRED', message: 'Indique o armazém.' })
    }
    if (input.blind !== undefined && typeof input.blind !== 'boolean') {
      issues.push({ path: 'blind', code: 'INVALID_FLAG', message: 'blind é booleano.' })
    }
    if (
      input.locationIds !== undefined &&
      (!Array.isArray(input.locationIds) || input.locationIds.some((l) => typeof l !== 'string'))
    ) {
      issues.push({
        path: 'locationIds',
        code: 'INVALID_REFERENCE',
        message: 'Lista de locais inválida.',
      })
    }
    if (
      input.notes !== undefined &&
      input.notes !== null &&
      (typeof input.notes !== 'string' || input.notes.length > 1000)
    ) {
      issues.push({ path: 'notes', code: 'INVALID_TEXT', message: 'Notas: até 1000 caracteres.' })
    }
    if (issues.length > 0) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const warehouse = await this.warehouses.find(scope, input.warehouseId as string)
      if (!warehouse) throw fail('warehouseId', 'UNKNOWN_WAREHOUSE', 'O armazém não existe.')
      if (!warehouse.active || warehouse.technical) {
        throw fail('warehouseId', 'WAREHOUSE_NOT_USABLE', 'O armazém está inactivo ou é técnico.')
      }
      const all = await this.warehouses.listLocations(scope, warehouse.id)
      const locations = all.filter((l) => l.active)
      const chosen = input.locationIds
        ? [...new Set(input.locationIds as string[])]
        : locations.map((l) => l.id)
      if (chosen.length === 0 || chosen.some((id) => !locations.some((l) => l.id === id))) {
        throw fail('locationIds', 'UNKNOWN_LOCATION', 'Indique locais activos deste armazém.')
      }
      const created = await this.counts.insert(scope, {
        organizationId: warehouse.organizationId,
        warehouseId: warehouse.id,
        blind: input.blind === true,
        locationIds: chosen.sort(),
        notes: ((input.notes as string | null | undefined) ?? null) || null,
      })
      return this.detail(scope, created.id)
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const count = await this.counts.find(scope, id, true)
      if (!count) throw ApiError.notFound()
      if (count.status !== 'DRAFT') {
        throw ApiError.conflict('COUNT_NOT_DRAFT', 'Só uma contagem em rascunho se apaga.')
      }
      await this.counts.remove(scope, id)
    }, context)
  }

  /** Abre: congela os locais, fotografa o esperado e numera. Idempotente. */
  open(context: TenantContext, id: string): Promise<CountDetail> {
    return this.uow.run(async (scope) => {
      const count = await this.counts.find(scope, id, true)
      if (!count) throw ApiError.notFound()
      if (count.status !== 'DRAFT') {
        if (count.status === 'CANCELLED') {
          throw ApiError.conflict('COUNT_CANCELLED', 'A contagem foi cancelada.')
        }
        return this.detail(scope, id)
      }
      const taken = await this.counts.freeze(scope, id, count.locationIds)
      if (taken.length > 0) {
        throw new ApiError(409, 'LOCATION_FROZEN', 'Há locais congelados por outra contagem.', [
          {
            path: 'locationIds',
            code: 'LOCATION_FROZEN',
            message: `Locais em contagem: ${taken.length}.`,
          },
        ])
      }
      for (const row of await this.counts.snapshotBalances(scope, count.locationIds)) {
        await this.counts.insertLine(scope, id, { ...row, expectedQty: row.onHand })
      }
      const number = await this.references.issueNumber(scope, {
        organizationId: count.organizationId,
        documentType: 'STOCK_COUNT',
        date: this.clock.now(),
      })
      await this.counts.setStatus(scope, id, { status: 'OPEN', number })
      return this.detail(scope, id)
    }, context)
  }

  /** Regista as quantidades contadas (também na reconferência). */
  count(
    context: TenantContext,
    id: string,
    input: { lines: { lineId: string; countedQty: string; reason?: string | null }[] }
  ): Promise<CountDetail> {
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw fail('lines', 'REQUIRED', 'Indique as linhas contadas.')
    }
    const issues: Issue[] = []
    input.lines.forEach((l, i) => {
      const quantity = parseQty(l.countedQty)
      if (quantity === null) {
        issues.push({
          path: `lines[${i}].countedQty`,
          code: 'INVALID_QUANTITY',
          message: 'Quantidade não negativa com até 6 casas.',
        })
      }
      if (
        l.reason !== undefined &&
        l.reason !== null &&
        (typeof l.reason !== 'string' || l.reason.length > 300)
      ) {
        issues.push({
          path: `lines[${i}].reason`,
          code: 'INVALID_TEXT',
          message: 'Motivo: até 300 caracteres.',
        })
      }
    })
    if (issues.length > 0) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const count = await this.requireCounting(scope, id)
      for (const l of input.lines) {
        const line = await this.counts.findLine(scope, count.id, l.lineId)
        if (!line) throw fail('lines', 'UNKNOWN_LINE', 'Uma linha não pertence a esta contagem.')
        await this.counts.setCounted(
          scope,
          line.id,
          qtyText(parseQty(l.countedQty) as bigint),
          l.reason?.trim() || null
        )
      }
      return this.detail(scope, id)
    }, context)
  }

  /** Acrescenta um artigo encontrado onde o sistema não esperava (esperado 0). */
  addLine(
    context: TenantContext,
    id: string,
    input: { variantId?: unknown; locationId?: unknown; lotId?: unknown }
  ): Promise<CountDetail> {
    if (typeof input.variantId !== 'string' || typeof input.locationId !== 'string') {
      throw fail('variantId', 'REQUIRED', 'Indique a variante e o local.')
    }
    return this.uow.run(async (scope) => {
      const count = await this.requireCounting(scope, id)
      if (!count.locationIds.includes(input.locationId as string)) {
        throw fail('locationId', 'LOCATION_NOT_IN_COUNT', 'O local não faz parte desta contagem.')
      }
      const variant = await this.references.variant(scope.context, input.variantId as string)
      if (!variant || !variant.active || !variant.product.trackStock) {
        throw fail(
          'variantId',
          'UNKNOWN_VARIANT',
          'A variante não existe ou não tem controlo de stock.'
        )
      }
      const lotId = (input.lotId as string | null | undefined) ?? null
      if ((variant.product.trackingMode === 'NONE') !== (lotId === null)) {
        throw fail(
          'lotId',
          'LOT_MISMATCH',
          'O lote só se indica nos produtos com rastreio por lote.'
        )
      }
      const existing = await this.counts.lines(scope, id)
      if (existing.length >= MAX_LINES * 50) {
        throw fail('lines', 'TOO_MANY', 'Demasiadas linhas.')
      }
      const created = await this.counts.insertLine(scope, id, {
        variantId: variant.id,
        locationId: input.locationId as string,
        lotId,
        expectedQty: qtyText(0n),
      })
      if (!created) throw ApiError.conflict('COUNT_LINE_EXISTS', 'Esse artigo já está na contagem.')
      return this.detail(scope, id)
    }, context)
  }

  /** Passa à revisão (mostra o esperado e as diferenças); exige todas as linhas contadas. */
  review(context: TenantContext, id: string): Promise<CountDetail> {
    return this.uow.run(async (scope) => {
      const count = await this.counts.find(scope, id, true)
      if (!count) throw ApiError.notFound()
      if (count.status === 'REVIEW') return this.detail(scope, id)
      if (count.status !== 'OPEN') throw this.notAllowed(count, 'rever')
      const lines = await this.counts.lines(scope, id)
      const missing = lines.filter((l) => l.countedQty === null)
      if (missing.length > 0) {
        throw new ApiError(
          422,
          'VALIDATION_ERROR',
          'Há linhas por contar.',
          missing.map((l) => ({
            path: `lines.${l.id}`,
            code: 'UNCOUNTED_LINE',
            message: 'Falta a quantidade contada.',
          }))
        )
      }
      await this.counts.setStatus(scope, id, { status: 'REVIEW' })
      return this.detail(scope, id)
    }, context)
  }

  /** Volta da revisão à contagem para reconferir. */
  reopen(context: TenantContext, id: string): Promise<CountDetail> {
    return this.uow.run(async (scope) => {
      const count = await this.counts.find(scope, id, true)
      if (!count) throw ApiError.notFound()
      if (count.status === 'OPEN') return this.detail(scope, id)
      if (count.status !== 'REVIEW') throw this.notAllowed(count, 'reconferir')
      await this.counts.setStatus(scope, id, { status: 'OPEN' })
      return this.detail(scope, id)
    }, context)
  }

  /** Lança os ajustes aprovados (um por diferença, idempotente) e descongela os locais. */
  post(context: TenantContext, id: string): Promise<CountDetail> {
    return this.uow.run(async (scope) => {
      const count = await this.counts.find(scope, id, true)
      if (!count) throw ApiError.notFound()
      if (count.status === 'POSTED') return this.detail(scope, id)
      if (count.status !== 'REVIEW') throw this.notAllowed(count, 'lançar')
      const lines = await this.counts.lines(scope, id)
      for (const line of lines) {
        const diff = variance(line.expectedQty, line.countedQty)
        if (diff === null || fromDb(diff, 6) === 0n) continue
        await this.stock.postInScope(scope, {
          kind: 'ADJUSTMENT',
          variantId: line.variantId,
          locationId: line.locationId,
          lotId: line.lotId,
          quantityDelta: diff,
          source: { type: COUNT_SOURCE, id, lineId: line.id, effect: 'ADJ' },
          reason: `Contagem ${count.number ?? ''}${line.reason ? `: ${line.reason}` : ''}`.slice(
            0,
            300
          ),
        })
      }
      await this.counts.unfreeze(scope, id)
      const after = await this.counts.setStatus(scope, id, { status: 'POSTED' })
      await this.outbox.append(scope, {
        aggregateType: 'stock_count',
        aggregateId: id,
        aggregateVersion: after.version,
        eventType: 'inventory.count.posted',
        payload: { countId: id, number: count.number, organizationId: count.organizationId },
        correlationId: context.correlationId,
      })
      return this.detail(scope, id)
    }, context)
  }

  cancel(context: TenantContext, id: string, reason: string): Promise<CountDetail> {
    const text = reason.trim()
    if (!text) throw fail('reason', 'REQUIRED', 'Indique o motivo.')
    return this.uow.run(async (scope) => {
      const count = await this.counts.find(scope, id, true)
      if (!count) throw ApiError.notFound()
      if (count.status === 'CANCELLED') return this.detail(scope, id)
      if (count.status === 'POSTED') {
        throw ApiError.conflict('COUNT_POSTED', 'Uma contagem lançada não se cancela.')
      }
      await this.counts.unfreeze(scope, id)
      await this.counts.setStatus(scope, id, { status: 'CANCELLED', reason: text })
      return this.detail(scope, id)
    }, context)
  }

  private async requireCounting(scope: TenantScope, id: string): Promise<Count> {
    const count = await this.counts.find(scope, id, true)
    if (!count) throw ApiError.notFound()
    if (count.status !== 'OPEN' && count.status !== 'REVIEW') throw this.notAllowed(count, 'contar')
    return count
  }

  private notAllowed(count: Count, action: string) {
    return ApiError.conflict(
      'COUNT_STATE',
      `Não se pode ${action} uma contagem no estado ${count.status}.`
    )
  }
}
