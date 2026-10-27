import { LucidOutboxWriter } from '#core/outbox/index'
import { organizationServices } from '#core/organization/index'
import { settingsServices } from '#core/settings/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { catalogServices } from '#modules/catalog/index'
import { customerServices } from '#modules/customers/index'
import { LineEngine } from '#modules/orders/application/line_engine'
import type { References } from '#modules/orders/application/ports'
import { OrderUseCases, QuoteUseCases } from '#modules/orders/application/sales_use_cases'
import {
  LucidLineStore,
  LucidOrderStore,
  LucidQuoteStore,
} from '#modules/orders/infrastructure/lucid_sales'
import type { RoundingMode } from '#modules/orders/domain/money'

/** Série única por omissão: a numeração por série configura-se nas sequências do tenant (C09). */
const SERIES = 'A'

/** Organizações, clientes, catálogo e configurações vêm dos seus módulos, pelas APIs públicas. */
const references: References = {
  async organizationExists(context, organizationId) {
    try {
      await organizationServices().organizations.get(context, organizationId)
      return true
    } catch {
      return false
    }
  },
  async customer(context, customerId) {
    try {
      const customer = await customerServices().customers.get(context, customerId)
      return {
        id: customer.id,
        organizationId: customer.organizationId,
        currency: customer.currency,
        status: customer.status,
      }
    } catch {
      return null
    }
  },
  async assertSaleAllowed(context, customerId) {
    await customerServices().customers.assertSaleAllowed(context, customerId)
  },
  async variant(context, variantId) {
    try {
      const variant = await catalogServices().catalog.getVariant(context, variantId)
      return {
        id: variant.id,
        sku: variant.sku,
        attributes: variant.attributes,
        active: variant.active,
        product: {
          id: variant.product.id,
          name: variant.product.name,
          baseUnitId: variant.product.baseUnitId,
          taxCategory: variant.product.taxCategory,
          active: variant.product.active,
        },
      }
    } catch {
      return null
    }
  },
  async resolvePrice(context, query) {
    return catalogServices().prices.resolve(context, query)
  },
  async taxRates(context, organizationId, date) {
    const rates = await settingsServices().taxRates.list(context, { organizationId, on: date })
    return rates.map((r) => ({ code: r.code, rate: r.rate, category: r.category }))
  },
  async unitPrecision(context, unitId) {
    const units = await settingsServices().units.list(context)
    return units.find((u) => u.id === unitId)?.precision ?? null
  },
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
  const quotes = new LucidQuoteStore()
  const orders = new LucidOrderStore()
  const lines = new LucidLineStore()
  const engine = new LineEngine(references)
  const outbox = new LucidOutboxWriter()
  const clock = { now: () => new Date() }
  return {
    quotes: new QuoteUseCases(uow, quotes, orders, lines, engine, references, outbox, clock),
    orders: new OrderUseCases(uow, orders, lines, engine, references, outbox, clock),
  }
}

let instance: ReturnType<typeof build> | undefined

export const orderServices = () => (instance ??= build())
