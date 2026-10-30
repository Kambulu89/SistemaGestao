import { LucidOutboxWriter } from '#core/outbox/index'
import { organizationServices } from '#core/organization/index'
import { partyServices } from '#core/party/index'
import { settingsServices } from '#core/settings/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { catalogServices } from '#modules/catalog/index'
import { customerServices } from '#modules/customers/index'
import { orderServices, type RoundingMode } from '#modules/orders/index'
import { ContractUseCases } from '#modules/invoicing/application/contract_use_cases'
import { CreditNoteUseCases } from '#modules/invoicing/application/credit_note_use_cases'
import { InvoiceUseCases } from '#modules/invoicing/application/invoice_use_cases'
import type { References } from '#modules/invoicing/application/ports'
import {
  LucidContractStore,
  LucidCreditNoteStore,
  LucidInvoiceStore,
} from '#modules/invoicing/infrastructure/lucid_invoicing'

/** Série única por omissão: a numeração por série configura-se nas sequências do tenant (C09). */
const SERIES = 'A'

/** Organizações, clientes, Party, encomendas, catálogo e configurações vêm dos seus módulos, pelas APIs públicas. */
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
  async customer(context, customerId) {
    try {
      const customer = await customerServices().customers.get(context, customerId)
      return {
        id: customer.id,
        code: customer.code,
        organizationId: customer.organizationId,
        partyId: customer.partyId,
        currency: customer.currency,
        paymentTermDays: customer.paymentTermDays,
        partyName: customer.partyName,
        taxId: customer.taxId,
      }
    } catch {
      return null
    }
  },
  async customerSnapshot(context, customer) {
    const { detail } = await partyServices().parties.get(context, customer.partyId)
    const addresses = detail.addresses
    const billing =
      addresses.find((a) => a.type === 'BILLING' && a.isPrimary) ??
      addresses.find((a) => a.type === 'BILLING') ??
      addresses.find((a) => a.isPrimary) ??
      addresses[0]
    return {
      customerId: customer.id,
      customerCode: customer.code,
      partyId: customer.partyId,
      name: customer.partyName,
      taxCountry: detail.organization?.taxCountry ?? null,
      taxId: customer.taxId,
      billingAddress: billing
        ? {
            line1: billing.line1,
            line2: billing.line2,
            city: billing.city,
            postalCode: billing.postalCode,
            countryCode: billing.countryCode,
          }
        : null,
    }
  },
  async order(context, orderId) {
    try {
      const order = await orderServices().orders.get(context, orderId)
      return {
        id: order.id,
        organizationId: order.organizationId,
        customerId: order.customerId,
        currency: order.currency,
        status: order.status,
        lines: order.lines.map((l) => ({
          id: l.id,
          variantId: l.variantId,
          description: l.descriptionSnapshot,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountRate: l.discountRate,
          taxRate: l.taxRateSnapshot,
          taxInclusive: l.taxInclusive,
          shippedQty: l.shippedQty ?? '0.000000',
        })),
      }
    } catch {
      return null
    }
  },
  async stockTracked(context, variantId) {
    try {
      const variant = await catalogServices().catalog.getVariant(context, variantId)
      return variant.product.trackStock
    } catch {
      return false
    }
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
  const contracts = new LucidContractStore()
  const invoices = new LucidInvoiceStore()
  const notes = new LucidCreditNoteStore()
  const outbox = new LucidOutboxWriter()
  const clock = { now: () => new Date() }
  return {
    contracts: new ContractUseCases(uow, contracts, references, clock),
    invoices: new InvoiceUseCases(uow, invoices, contracts, references, outbox, clock),
    creditNotes: new CreditNoteUseCases(uow, notes, invoices, references, outbox, clock),
  }
}

let instance: ReturnType<typeof build> | undefined

export const invoicingServices = () => (instance ??= build())
