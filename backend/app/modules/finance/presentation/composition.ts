import { LucidOutboxWriter } from '#core/outbox/index'
import { organizationServices } from '#core/organization/index'
import { partyServices } from '#core/party/index'
import { settingsServices } from '#core/settings/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { procurementServices } from '#modules/procurement/index'
import type { RoundingMode } from '#core/decimal/index'
import { AccountUseCases } from '#modules/finance/application/account_use_cases'
import { CreditUseCases } from '#modules/finance/application/credit_use_cases'
import { ObligationUseCases } from '#modules/finance/application/obligation_use_cases'
import { PaymentUseCases } from '#modules/finance/application/payment_use_cases'
import { SupplierInvoiceUseCases } from '#modules/finance/application/supplier_invoice_use_cases'
import type { References } from '#modules/finance/application/ports'
import {
  LucidAccountStore,
  LucidCreditStore,
  LucidObligationStore,
  LucidPaymentStore,
  LucidSupplierInvoiceStore,
} from '#modules/finance/infrastructure/lucid_finance'

/** Organizações, Party, compras e configurações vêm dos seus módulos, pelas APIs públicas. */
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
  async supplier(context, supplierId) {
    try {
      const s = await procurementServices().suppliers.get(context, supplierId)
      return {
        id: s.id,
        partyId: s.partyId,
        organizationId: s.organizationId,
        paymentTermDays: s.paymentTermDays,
        currency: s.currency,
        status: s.status,
      }
    } catch {
      return null
    }
  },
  async purchaseOrder(context, orderId) {
    try {
      const o = await procurementServices().purchases.get(context, orderId)
      return {
        id: o.id,
        organizationId: o.organizationId,
        supplierId: o.supplierId,
        currency: o.currency,
        status: o.status,
        lines: o.lines.map((l) => ({
          id: l.id,
          unitCost: l.unitCost,
          receivedQty: l.receivedQty ?? '0',
        })),
      }
    } catch {
      return null
    }
  },
  async roundingMode(context, organizationId) {
    const values = await settingsServices().resolveSettings.execute(context, { organizationId })
    const mode = values.find((v) => v.key === 'tax.roundingMode')?.value
    return (mode === 'HALF_EVEN' ? 'HALF_EVEN' : 'HALF_UP') satisfies RoundingMode
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const accounts = new LucidAccountStore()
  const obligations = new LucidObligationStore()
  const payments = new LucidPaymentStore()
  const invoices = new LucidSupplierInvoiceStore()
  const credit = new LucidCreditStore()
  const outbox = new LucidOutboxWriter()
  const clock = { now: () => new Date() }
  return {
    accounts: new AccountUseCases(uow, accounts, payments, references),
    obligations: new ObligationUseCases(uow, obligations, clock),
    payments: new PaymentUseCases(uow, payments, accounts, obligations, references, outbox, clock),
    supplierInvoices: new SupplierInvoiceUseCases(
      uow,
      invoices,
      obligations,
      references,
      outbox,
      clock
    ),
    credit: new CreditUseCases(uow, credit, obligations, clock),
  }
}

let instance: ReturnType<typeof build> | undefined

export const financeServices = () => (instance ??= build())
