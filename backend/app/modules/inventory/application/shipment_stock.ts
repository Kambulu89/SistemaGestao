import { ApiError } from '#core/http/api_error'
import type { TenantScope } from '#core/tenancy/index'
import { fromDb, parseQty, qtyText } from '#modules/inventory/domain/decimal'
import type {
  LedgerStore,
  References,
  ReservationStore,
  WarehouseStore,
} from '#modules/inventory/application/ports'
import { ORDER_SOURCE } from '#modules/inventory/application/order_stock'
import {
  remainingOf,
  type Clock,
  type StockUseCases,
} from '#modules/inventory/application/stock_use_cases'

export interface ShipmentRef {
  id: string
  orderId: string
  organizationId: string
}
export interface ShipmentLineRef {
  id: string
  orderLineId: string
  variantId: string
  quantity: string
}

export const SHIPMENT_SOURCE = 'SHIPMENT'
const REASON = 'Reversão da expedição'

/**
 * Ligação às expedições (spec 9.3): lançar baixa o stock **consumindo primeiro as reservas** da linha da encomenda e, para
 * o que não estava reservado, o stock livre do armazém de vendas (por validade); reverter repõe-no com movimentos opostos.
 * Sem reservas nem armazém de vendas a organização não controla stock nas vendas e nada se move. Tudo na transacção do
 * lançamento: se faltar stock, a expedição não se lança.
 */
export class ShipmentStock {
  constructor(
    private readonly warehouses: WarehouseStore,
    private readonly ledger: LedgerStore,
    private readonly reservations: ReservationStore,
    private readonly stock: StockUseCases,
    private readonly references: References,
    private readonly clock: Clock
  ) {}

  async post(
    scope: TenantScope,
    shipment: ShipmentRef,
    lines: readonly ShipmentLineRef[]
  ): Promise<void> {
    const warehouse = await this.warehouses.findSalesDefault(scope, shipment.organizationId)
    const today = this.clock.now().toISOString().slice(0, 10)
    // Sempre pela mesma ordem (variante, depois linha) para os bloqueios nunca se cruzarem entre expedições.
    const ordered = lines
      .map((line, index) => ({ line, index }))
      .sort((a, b) =>
        a.line.variantId === b.line.variantId
          ? a.line.id < b.line.id
            ? -1
            : 1
          : a.line.variantId < b.line.variantId
            ? -1
            : 1
      )
    for (const { line, index } of ordered) {
      const variant = await this.references.variant(scope.context, line.variantId)
      // Serviços e produtos sem controlo de stock não baixam nada.
      if (!variant || !variant.product.trackStock) continue
      let missing = parseQty(line.quantity) ?? 0n

      const reserved = await this.reservations.lockActiveBySourceLine(
        scope,
        ORDER_SOURCE,
        shipment.orderId,
        line.orderLineId
      )
      for (const [at, reservation] of reserved.entries()) {
        if (missing === 0n) break
        const left = remainingOf(reservation)
        const take = left < missing ? left : missing
        await this.stock.postInScope(scope, {
          kind: 'ISSUE',
          variantId: line.variantId,
          locationId: reservation.locationId,
          lotId: reservation.lotId,
          quantityDelta: `-${qtyText(take)}`,
          source: { type: SHIPMENT_SOURCE, id: shipment.id, lineId: line.id, effect: `R${at}` },
          reservationId: reservation.id,
        })
        missing -= take
      }

      if (missing > 0n && warehouse) {
        const candidates = await this.ledger.lockCandidates(scope, line.variantId, warehouse.id)
        for (const [at, candidate] of candidates.entries()) {
          if (missing === 0n) break
          if (candidate.expiresOn && candidate.expiresOn < today) continue
          const free = fromDb(candidate.onHand, 6) - fromDb(candidate.reserved, 6)
          if (free <= 0n) continue
          const take = free < missing ? free : missing
          await this.stock.postInScope(scope, {
            kind: 'ISSUE',
            variantId: line.variantId,
            locationId: candidate.locationId,
            lotId: candidate.lotId,
            quantityDelta: `-${qtyText(take)}`,
            source: { type: SHIPMENT_SOURCE, id: shipment.id, lineId: line.id, effect: `F${at}` },
          })
          missing -= take
        }
        // Um armazém que aceita saldo negativo deixa expedir o que falta, sem lote (nunca em produtos por lote).
        if (missing > 0n && warehouse.allowNegative && variant.product.trackingMode === 'NONE') {
          const known = candidates[0] ? { id: candidates[0].locationId } : null
          const locations = known ? [] : await this.warehouses.listLocations(scope, warehouse.id)
          const location = known ?? locations.find((l) => l.active)
          if (location) {
            await this.stock.postInScope(scope, {
              kind: 'ISSUE',
              variantId: line.variantId,
              locationId: location.id,
              lotId: null,
              quantityDelta: `-${qtyText(missing)}`,
              source: { type: SHIPMENT_SOURCE, id: shipment.id, lineId: line.id, effect: 'N' },
            })
            missing = 0n
          }
        }
      }

      if (missing > 0n && (warehouse || reserved.length > 0)) {
        throw new ApiError(409, 'SHIPMENT_NOT_POSTABLE', 'A expedição não pode ser lançada.', [
          {
            path: `lines[${index}].quantity`,
            code: 'INSUFFICIENT_STOCK',
            message: `Stock insuficiente: faltam ${qtyText(missing)}.`,
          },
        ])
      }
    }
  }

  /** Repõe o stock das baixas da expedição com movimentos opostos ao custo original. */
  async reverse(scope: TenantScope, shipment: ShipmentRef): Promise<void> {
    const movements = await this.ledger.movementsBySource(scope, SHIPMENT_SOURCE, shipment.id)
    for (const movement of movements) {
      await this.stock.reverseInScope(scope, movement, REASON)
    }
  }
}
