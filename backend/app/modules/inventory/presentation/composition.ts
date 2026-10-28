import { LucidOutboxWriter } from '#core/outbox/index'
import { organizationServices } from '#core/organization/index'
import { settingsServices } from '#core/settings/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { catalogServices } from '#modules/catalog/index'
import { OrderStock } from '#modules/inventory/application/order_stock'
import type { References } from '#modules/inventory/application/ports'
import { StockUseCases } from '#modules/inventory/application/stock_use_cases'
import { WarehouseUseCases } from '#modules/inventory/application/warehouse_use_cases'
import {
  LucidLedgerStore,
  LucidLotStore,
  LucidReservationStore,
  LucidWarehouseStore,
} from '#modules/inventory/infrastructure/lucid_inventory'

/** Organizações, catálogo e unidades vêm dos seus módulos, pelas APIs públicas. */
const references: References = {
  async organizationExists(context, organizationId) {
    try {
      await organizationServices().organizations.get(context, organizationId)
      return true
    } catch {
      return false
    }
  },
  async variant(context, variantId) {
    try {
      const variant = await catalogServices().catalog.getVariant(context, variantId)
      return {
        id: variant.id,
        active: variant.active,
        product: {
          id: variant.product.id,
          baseUnitId: variant.product.baseUnitId,
          trackStock: variant.product.trackStock,
          trackingMode: variant.product.trackingMode,
        },
      }
    } catch {
      return null
    }
  },
  async unitPrecision(context, unitId) {
    const units = await settingsServices().units.list(context)
    return units.find((u) => u.id === unitId)?.precision ?? null
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const warehouses = new LucidWarehouseStore()
  const lots = new LucidLotStore()
  const ledger = new LucidLedgerStore()
  const reservations = new LucidReservationStore()
  const outbox = new LucidOutboxWriter()
  const clock = { now: () => new Date() }
  const stock = new StockUseCases(
    uow,
    warehouses,
    lots,
    ledger,
    reservations,
    references,
    outbox,
    clock
  )
  return {
    warehouses: new WarehouseUseCases(uow, warehouses, lots, references),
    stock,
    orderStock: new OrderStock(warehouses, ledger, reservations, stock, references, outbox, clock),
    ledger,
  }
}

let instance: ReturnType<typeof build> | undefined

export const inventoryServices = () => (instance ??= build())
