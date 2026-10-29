import { LucidOutboxWriter } from '#core/outbox/index'
import { organizationServices } from '#core/organization/index'
import { partyServices } from '#core/party/index'
import { settingsServices } from '#core/settings/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { catalogServices } from '#modules/catalog/index'
import { runWarehouseCheck } from '#modules/procurement/application/registry'
import type { References } from '#modules/procurement/application/ports'
import { PurchaseUseCases } from '#modules/procurement/application/purchase_use_cases'
import { ReceiptUseCases } from '#modules/procurement/application/receipt_use_cases'
import { RequisitionUseCases } from '#modules/procurement/application/requisition_use_cases'
import { SupplierUseCases } from '#modules/procurement/application/supplier_use_cases'
import {
  LucidPurchaseStore,
  LucidReceiptStore,
  LucidRequisitionStore,
  LucidSupplierStore,
} from '#modules/procurement/infrastructure/lucid_procurement'
import type { RoundingMode } from '#modules/procurement/domain/decimal'

/** Série única por omissão: a numeração por série configura-se nas sequências do tenant (C09). */
const SERIES = 'A'

/** Organizações, Party, catálogo, inventário e configurações vêm dos seus módulos, pelas APIs públicas. */
const references: References = {
  async organizationCurrency(context, organizationId) {
    try {
      const organization = await organizationServices().organizations.get(context, organizationId)
      return organization.baseCurrency
    } catch {
      return null
    }
  },
  async partyExists(context, partyId) {
    try {
      await partyServices().parties.get(context, partyId)
      return true
    } catch {
      return false
    }
  },
  async variant(context, variantId) {
    try {
      const variant = await catalogServices().catalog.getVariant(context, variantId)
      const attributes = Object.values(variant.attributes ?? {}).join(', ')
      return {
        id: variant.id,
        sku: variant.sku,
        description:
          `${variant.product.name} — ${variant.sku}${attributes ? ` (${attributes})` : ''}`.slice(
            0,
            500
          ),
        active: variant.active && variant.product.active,
        trackStock: variant.product.trackStock,
      }
    } catch {
      return null
    }
  },
  warehouseUsable: (context, warehouseId, organizationId) =>
    runWarehouseCheck(context, warehouseId, organizationId),
  async roundingMode(context, organizationId) {
    const values = await settingsServices().resolveSettings.execute(context, { organizationId })
    const mode = values.find((v) => v.key === 'tax.roundingMode')?.value
    return (mode === 'HALF_EVEN' ? 'HALF_EVEN' : 'HALF_UP') satisfies RoundingMode
  },
  async issueNumber(scope, input) {
    const issued = await settingsServices().sequenceIssuer.issue(scope, {
      organizationId: input.organizationId,
      documentType: input.documentType,
      series: SERIES,
      date: input.date,
    })
    return issued.number
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const suppliers = new LucidSupplierStore()
  const requisitions = new LucidRequisitionStore()
  const purchases = new LucidPurchaseStore()
  const receipts = new LucidReceiptStore()
  const outbox = new LucidOutboxWriter()
  const clock = { now: () => new Date() }
  return {
    suppliers: new SupplierUseCases(uow, suppliers, references),
    requisitions: new RequisitionUseCases(uow, requisitions, references, clock),
    purchases: new PurchaseUseCases(
      uow,
      purchases,
      suppliers,
      requisitions,
      receipts,
      references,
      outbox,
      clock
    ),
    receipts: new ReceiptUseCases(uow, receipts, purchases, references, outbox, clock),
  }
}

let instance: ReturnType<typeof build> | undefined

export const procurementServices = () => (instance ??= build())
