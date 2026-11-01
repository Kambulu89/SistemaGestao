import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantScope } from '#core/tenancy/index'
import { fromDb, parseQty, qtyText } from '#modules/inventory/domain/decimal'
import type {
  LedgerStore,
  References,
  ReservationStore,
  WarehouseStore,
} from '#modules/inventory/application/ports'
import {
  remainingOf,
  type Clock,
  type StockUseCases,
} from '#modules/inventory/application/stock_use_cases'

/** O que a integração precisa de uma encomenda e das suas linhas (o módulo de encomendas passa-os). */
export interface OrderRef {
  id: string
  organizationId: string
  version: number
}
export interface OrderLineRef {
  id: string
  variantId: string
  quantity: string
}

export const ORDER_SOURCE = 'SALES_ORDER'

/**
 * Ligação às encomendas (spec 9.3): ao confirmar, reserva o stock do **armazém de vendas** da organização na mesma
 * transacção; ao cancelar, liberta o que não foi consumido. Sem armazém de vendas configurado não faz nada (a
 * organização não controla stock nas vendas). Reservar não expede nem baixa o stock.
 */
export class OrderStock {
  constructor(
    private readonly warehouses: WarehouseStore,
    private readonly ledger: LedgerStore,
    private readonly reservations: ReservationStore,
    private readonly stock: StockUseCases,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  async reserveOrder(
    scope: TenantScope,
    order: OrderRef,
    lines: readonly OrderLineRef[]
  ): Promise<void> {
    const warehouse = await this.warehouses.findSalesDefault(scope, order.organizationId)
    if (!warehouse) return

    // Só as linhas com controlo de stock; por variante e linha, para bloquear sempre pela mesma ordem.
    const tracked: { line: OrderLineRef; index: number; quantity: bigint }[] = []
    for (const [index, line] of lines.entries()) {
      const variant = await this.references.variant(scope.context, line.variantId)
      if (!variant || !variant.product.trackStock) continue
      if (variant.product.trackingMode === 'SERIAL') {
        throw this.notConfirmable(
          index,
          'SERIAL_NOT_SUPPORTED',
          'O rastreio por número de série ainda não está disponível.'
        )
      }
      tracked.push({ line, index, quantity: parseQty(line.quantity) ?? 0n })
    }
    tracked.sort((a, b) =>
      a.line.variantId === b.line.variantId
        ? a.index - b.index
        : a.line.variantId < b.line.variantId
          ? -1
          : 1
    )

    const today = this.clock.now().toISOString().slice(0, 10)
    const shortfalls: { lineId: string; variantId: string; missing: string }[] = []
    const reserved: {
      lineId: string
      locationId: string
      lotId: string | null
      quantity: string
    }[] = []
    let currentVariant: string | null = null
    let candidates: Awaited<ReturnType<LedgerStore['lockCandidates']>> = []
    for (const { line, index, quantity } of tracked) {
      if (line.variantId !== currentVariant) {
        currentVariant = line.variantId
        // Bloqueia todos os saldos da variante no armazém, por validade (FEFO) e depois lote/local.
        candidates = await this.ledger.lockCandidates(scope, line.variantId, warehouse.id)
      }
      let remaining = quantity
      for (const [at, candidate] of candidates.entries()) {
        if (remaining === 0n) break
        if (candidate.expiresOn && candidate.expiresOn < today) continue
        const available = fromDb(candidate.onHand, 6) - fromDb(candidate.reserved, 6)
        if (available <= 0n) continue
        const take = available < remaining ? available : remaining
        const reservation = await this.stock.applyReservation(scope, candidate, take, {
          organizationId: order.organizationId,
          variantId: line.variantId,
          locationId: candidate.locationId,
          lotId: candidate.lotId,
          sourceType: ORDER_SOURCE,
          sourceId: order.id,
          sourceLineId: line.id,
          expiresAt: null,
        })
        // O saldo em memória acompanha o que acabou de ser gravado (a mesma variante pode ter outra linha).
        candidates[at] = {
          ...candidate,
          reserved: qtyText(fromDb(candidate.reserved, 6) + take),
        }
        reserved.push({
          lineId: line.id,
          locationId: reservation.locationId,
          lotId: reservation.lotId,
          quantity: reservation.quantity,
        })
        remaining -= take
      }
      if (remaining > 0n) {
        if (!warehouse.allowBackorder) {
          throw this.notConfirmable(
            index,
            'INSUFFICIENT_STOCK',
            `Stock insuficiente no armazém ${warehouse.code}: faltam ${qtyText(remaining)}.`
          )
        }
        shortfalls.push({ lineId: line.id, variantId: line.variantId, missing: qtyText(remaining) })
      }
    }
    if (reserved.length === 0 && shortfalls.length === 0) return
    await this.outbox.append(scope, {
      aggregateType: 'sales_order',
      aggregateId: order.id,
      aggregateVersion: order.version,
      eventType: 'inventory.order_stock.reserved',
      payload: { orderId: order.id, warehouseId: warehouse.id, reserved, backorder: shortfalls },
      correlationId: scope.context.correlationId,
    })
  }

  /** Liberta as reservas activas da encomenda (cancelada). Idempotente: sem reservas activas, nada acontece. */
  async releaseOrder(scope: TenantScope, order: OrderRef): Promise<void> {
    const active = await this.reservations.lockActiveBySource(scope, ORDER_SOURCE, order.id)
    if (active.length === 0) return
    for (const reservation of active) {
      await this.stock.releaseInScope(scope, reservation, remainingOf(reservation), false)
    }
    await this.outbox.append(scope, {
      aggregateType: 'sales_order',
      aggregateId: order.id,
      aggregateVersion: order.version,
      eventType: 'inventory.order_stock.released',
      payload: { orderId: order.id, reservations: active.length },
      correlationId: scope.context.correlationId,
    })
  }

  private notConfirmable(index: number, code: string, message: string) {
    return new ApiError(409, 'ORDER_NOT_CONFIRMABLE', 'A encomenda não pode ser confirmada.', [
      { path: `lines[${index}].quantity`, code, message },
    ])
  }
}
