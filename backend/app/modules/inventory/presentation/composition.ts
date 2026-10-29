import { LucidOutboxWriter } from '#core/outbox/index'
import { organizationServices } from '#core/organization/index'
import { settingsServices } from '#core/settings/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { catalogServices } from '#modules/catalog/index'
import { CountUseCases } from '#modules/inventory/application/count_use_cases'
import { OrderStock } from '#modules/inventory/application/order_stock'
import { ReceiptStock } from '#modules/inventory/application/receipt_stock'
import { ReturnUseCases } from '#modules/inventory/application/return_use_cases'
import { ShipmentStock } from '#modules/inventory/application/shipment_stock'
import type { References } from '#modules/inventory/application/ports'
import { StockUseCases } from '#modules/inventory/application/stock_use_cases'
import { TransferUseCases } from '#modules/inventory/application/transfer_use_cases'
import { WarehouseUseCases } from '#modules/inventory/application/warehouse_use_cases'
import {
  LucidCountStore,
  LucidReturnStore,
  LucidTransferStore,
} from '#modules/inventory/infrastructure/lucid_logistics'
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
  async issueNumber(scope, input) {
    const issued = await settingsServices().sequenceIssuer.issue(scope, {
      organizationId: input.organizationId,
      documentType: input.documentType,
      series: 'A',
      date: input.date,
    })
    return issued.number
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
    shipmentStock: new ShipmentStock(warehouses, ledger, reservations, stock, references, clock),
    receiptStock: new ReceiptStock(warehouses, lots, ledger, stock, references),
    ledger,
    transfers: new TransferUseCases(
      uow,
      new LucidTransferStore(),
      warehouses,
      stock,
      references,
      outbox,
      clock
    ),
    counts: new CountUseCases(
      uow,
      new LucidCountStore(),
      warehouses,
      stock,
      references,
      outbox,
      clock
    ),
    returns: new ReturnUseCases(
      uow,
      new LucidReturnStore(),
      warehouses,
      stock,
      references,
      outbox,
      clock
    ),
  }
}

let instance: ReturnType<typeof build> | undefined

export const inventoryServices = () => (instance ??= build())
