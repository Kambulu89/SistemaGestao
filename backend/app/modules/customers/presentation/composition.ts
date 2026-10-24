import { LucidMembershipStore } from '#core/membership/index'
import { organizationServices } from '#core/organization/index'
import { partyServices } from '#core/party/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import {
  CustomerUseCases,
  InteractionUseCases,
  SegmentUseCases,
} from '#modules/customers/application/customer_use_cases'
import type { References } from '#modules/customers/application/ports'
import {
  LucidCustomerStore,
  LucidInteractionStore,
  LucidSegmentStore,
} from '#modules/customers/infrastructure/lucid_customers'

/** Party, organizações e membros vêm dos seus módulos, pelas APIs públicas. */
const memberships = new LucidMembershipStore()
const references: References = {
  async partyExists(context, partyId) {
    try {
      await partyServices().parties.get(context, partyId)
      return true
    } catch {
      return false
    }
  },
  async organizationCurrency(context, organizationId) {
    try {
      const organization = await organizationServices().organizations.get(context, organizationId)
      return organization.baseCurrency
    } catch {
      return null
    }
  },
  async membershipActive(scope, membershipId) {
    const found = await memberships.findById(scope, membershipId)
    return found?.status === 'ACTIVE'
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const segments = new LucidSegmentStore()
  const customers = new LucidCustomerStore()
  const interactions = new LucidInteractionStore()
  return {
    segments: new SegmentUseCases(uow, segments),
    customers: new CustomerUseCases(uow, customers, segments, references),
    interactions: new InteractionUseCases(uow, interactions, references, {
      now: () => new Date(),
    }),
  }
}

let instance: ReturnType<typeof build> | undefined

export const customerServices = () => (instance ??= build())
