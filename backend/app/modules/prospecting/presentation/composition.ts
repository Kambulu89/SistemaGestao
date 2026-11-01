import { LucidMembershipStore } from '#core/membership/index'
import { organizationServices } from '#core/organization/index'
import { LucidOutboxWriter } from '#core/outbox/index'
import { partyServices } from '#core/party/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { customerServices } from '#modules/customers/index'
import {
  CampaignUseCases,
  ExclusionUseCases,
  LeadUseCases,
  OpportunityUseCases,
  StageUseCases,
} from '#modules/prospecting/application/prospecting_use_cases'
import type { CustomerRef, References } from '#modules/prospecting/application/ports'
import {
  LucidActivityStore,
  LucidCampaignStore,
  LucidExclusionStore,
  LucidLeadStore,
  LucidOpportunityStore,
  LucidStageStore,
} from '#modules/prospecting/infrastructure/lucid_prospecting'

const memberships = new LucidMembershipStore()

const refOf = (c: {
  id: string
  partyId: string
  organizationId: string
  currency: string
}): CustomerRef => ({
  id: c.id,
  partyId: c.partyId,
  organizationId: c.organizationId,
  currency: c.currency,
})

/**
 * Organizações, Party e clientes vêm dos seus módulos pelas APIs públicas. Chamados dentro de um caso de uso do CRM,
 * juntam-se à sua transacção (`LucidTenantDatabase.run` aninhado): a conversão de uma lead é toda ou nada.
 */
const references: References = {
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
      return refOf(await customerServices().customers.get(context, customerId))
    } catch {
      return null
    }
  },
  async partyByEmail(context, email) {
    const found = await partyServices().parties.list(context, { q: email, limit: 5, offset: 0 })
    const matches = []
    for (const party of found) {
      const { detail } = await partyServices().parties.get(context, party.id)
      if (detail.contacts.some((c) => c.type === 'EMAIL' && c.value.toLowerCase() === email)) {
        matches.push({ id: party.id, displayName: party.displayName })
      }
    }
    return matches.length === 1 ? (matches[0] ?? null) : null
  },
  async createParty(context, input) {
    const contacts = [
      ...(input.email
        ? [{ type: 'EMAIL' as const, value: input.email, label: null, isPrimary: true }]
        : []),
      ...(input.phone
        ? [{ type: 'PHONE' as const, value: input.phone, label: null, isPrimary: true }]
        : []),
    ]
    const base = { displayName: input.displayName, externalReference: null, contacts }
    const created =
      input.kind === 'ORGANIZATION'
        ? await partyServices().parties.createOrganization(context, {
            ...base,
            legalName: input.legalName as string,
            taxCountry: null,
            taxId: null,
            registrationNumber: null,
          })
        : await partyServices().parties.createPerson(context, {
            ...base,
            givenNames: input.givenNames as string,
            familyName: input.familyName as string,
            birthDate: null,
            nationality: null,
            identityType: null,
            identityNumber: null,
          })
    return { id: created.detail.party.id, displayName: created.detail.party.displayName }
  },
  async customerOfParty(context, partyId, organizationId) {
    const found = await customerServices().customers.list(context, {
      partyId,
      organizationId,
      limit: 1,
    })
    const customer = found.items[0]
    return customer ? refOf(customer) : null
  },
  async createCustomer(context, input) {
    const created = await customerServices().customers.create(
      context,
      {
        partyId: input.partyId,
        organizationId: input.organizationId,
        code: input.code,
        accountManagerMembershipId: input.accountManagerMembershipId,
      },
      { canManageCredit: false }
    )
    return refOf(created)
  },
  async partyDestination(context, partyId, kind) {
    try {
      const { detail } = await partyServices().parties.get(context, partyId)
      const wanted = detail.contacts.filter((c) => c.type === kind)
      return (wanted.find((c) => c.isPrimary) ?? wanted[0])?.value ?? null
    } catch {
      return null
    }
  },
}

function build() {
  const uow = new LucidTenantDatabase()
  const stageStore = new LucidStageStore()
  const leads = new LucidLeadStore()
  const opportunities = new LucidOpportunityStore()
  const activities = new LucidActivityStore()
  const campaigns = new LucidCampaignStore()
  const exclusions = new LucidExclusionStore()
  const outbox = new LucidOutboxWriter()
  const clock = { now: () => new Date() }
  const stages = new StageUseCases(uow, stageStore)
  return {
    stages,
    leads: new LeadUseCases(uow, leads, opportunities, stages, references, outbox),
    opportunities: new OpportunityUseCases(
      uow,
      opportunities,
      activities,
      leads,
      stages,
      stageStore,
      references,
      outbox,
      clock
    ),
    campaigns: new CampaignUseCases(uow, campaigns, leads, exclusions, references, outbox, clock),
    exclusions: new ExclusionUseCases(uow, exclusions),
  }
}

let instance: ReturnType<typeof build> | undefined

export const prospectingServices = () => (instance ??= build())
