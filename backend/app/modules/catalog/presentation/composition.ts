import { organizationServices } from '#core/organization/index'
import { settingsServices } from '#core/settings/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { CatalogUseCases } from '#modules/catalog/application/catalog_use_cases'
import type { References } from '#modules/catalog/application/ports'
import { PriceUseCases } from '#modules/catalog/application/price_use_cases'
import {
  LucidCategoryStore,
  LucidPriceStore,
  LucidProductStore,
  LucidVariantStore,
} from '#modules/catalog/infrastructure/lucid_catalog'

/** Unidades e organizações vêm dos módulos de configurações e de organização, pelas suas APIs públicas. */
const references: References = {
  async unitExists(context, unitId) {
    const units = await settingsServices().units.list(context)
    return units.some((u) => u.id === unitId)
  },
  async organizationExists(context, organizationId) {
    try {
      await organizationServices().organizations.get(context, organizationId)
      return true
    } catch {
      return false
    }
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const categories = new LucidCategoryStore()
  const products = new LucidProductStore()
  const variants = new LucidVariantStore()
  const prices = new LucidPriceStore()
  return {
    catalog: new CatalogUseCases(uow, categories, products, variants, references),
    prices: new PriceUseCases(uow, prices, products, variants, references),
  }
}

let instance: ReturnType<typeof build> | undefined

export const catalogServices = () => (instance ??= build())
