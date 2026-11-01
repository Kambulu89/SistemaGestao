import { LucidTenantDatabase } from '#core/tenancy/index'
import { LucidMembershipStore } from '#core/membership/index'
import { PartyUseCases } from '#core/party/application/use_cases'
import { LucidPartyStore } from '#core/party/infrastructure/lucid_party'

function build() {
  return {
    parties: new PartyUseCases(
      new LucidTenantDatabase(),
      new LucidPartyStore(),
      new LucidMembershipStore(),
      { today: () => new Date().toISOString().slice(0, 10) }
    ),
  }
}

let instance: ReturnType<typeof build> | undefined

export const partyServices = () => (instance ??= build())
