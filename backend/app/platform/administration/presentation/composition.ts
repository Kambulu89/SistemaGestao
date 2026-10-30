import {
  AuthorizePlatform,
  ChangeTenantLifecycle,
  GetPlatformTenant,
  GrantPlatformPermission,
  ListPlatformGrants,
  ListPlatformTenants,
  ProvisionTenant,
  RevokePlatformPermission,
} from '#platform/administration/application/use_cases'
import {
  LucidGrantStore,
  LucidProvisioningGateway,
} from '#platform/administration/infrastructure/lucid_administration'

function build() {
  const grants = new LucidGrantStore()
  const gateway = new LucidProvisioningGateway()
  return {
    authorize: new AuthorizePlatform(grants),
    grant: new GrantPlatformPermission(grants),
    revoke: new RevokePlatformPermission(grants),
    listGrants: new ListPlatformGrants(grants),
    provisionTenant: new ProvisionTenant(gateway),
    listTenants: new ListPlatformTenants(gateway),
    getTenant: new GetPlatformTenant(gateway),
    changeLifecycle: new ChangeTenantLifecycle(gateway),
  }
}

let instance: ReturnType<typeof build> | undefined

export const administrationServices = () => (instance ??= build())
