import { LucidTenantDatabase } from '#core/tenancy/index'
import { LucidMembershipStore } from '#core/membership/index'
import {
  CostCenterUseCases,
  OrganizationUseCases,
  ResolveUnitScope,
  ScopeUseCases,
  TeamUseCases,
  UnitUseCases,
} from '#core/organization/application/use_cases'
import { LucidOrganizationStore } from '#core/organization/infrastructure/lucid_organization'
import { PositionUseCases } from '#core/organization/application/position_use_cases'
import { LucidPositionStore } from '#core/organization/infrastructure/lucid_positions'

function build() {
  const uow = new LucidTenantDatabase()
  const store = new LucidOrganizationStore()
  const memberships = new LucidMembershipStore()
  return {
    organizations: new OrganizationUseCases(uow, store),
    units: new UnitUseCases(uow, store, memberships),
    costCenters: new CostCenterUseCases(uow, store, memberships),
    teams: new TeamUseCases(uow, store, memberships),
    scopes: new ScopeUseCases(uow, store, memberships),
    resolveUnitScope: new ResolveUnitScope(uow, store),
    positions: new PositionUseCases(uow, new LucidPositionStore(), store),
  }
}

let instance: ReturnType<typeof build> | undefined

export const organizationServices = () => (instance ??= build())
