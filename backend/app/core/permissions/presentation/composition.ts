import { LucidTenantDatabase } from '#core/tenancy/index'
import { LucidMembershipStore } from '#core/membership/index'
import { LucidOrganizationStore } from '#core/organization/index'
import {
  AssignmentUseCases,
  Authorize,
  EnsureTenantAdmin,
  ListEffectivePermissions,
  ListPermissions,
  PolicyUseCases,
  RoleUseCases,
  SimulateAuthorization,
  SyncPermissionCatalog,
} from '#core/permissions/application/use_cases'
import { LucidIamStore, LucidPermissionCatalog } from '#core/permissions/infrastructure/lucid_iam'

function build() {
  const uow = new LucidTenantDatabase()
  const store = new LucidIamStore()
  const memberships = new LucidMembershipStore()
  const organizations = new LucidOrganizationStore()
  const catalog = new LucidPermissionCatalog()
  const clock = { now: () => new Date() }
  return {
    authorize: new Authorize(uow, store, clock),
    effectivePermissions: new ListEffectivePermissions(uow, store, clock),
    simulate: new SimulateAuthorization(uow, store, memberships, clock, (scope, membershipId) =>
      organizations.expandUnitScope(scope, membershipId)
    ),
    permissions: new ListPermissions(catalog),
    roles: new RoleUseCases(uow, store, memberships),
    assignments: new AssignmentUseCases(
      uow,
      store,
      memberships,
      async (scope, unitId) => (await organizations.findUnit(scope, unitId)) !== null
    ),
    policies: new PolicyUseCases(uow, store, memberships),
    syncCatalog: new SyncPermissionCatalog(catalog),
    ensureTenantAdmin: new EnsureTenantAdmin(uow, store, memberships),
  }
}

let instance: ReturnType<typeof build> | undefined

export const iamServices = () => (instance ??= build())
