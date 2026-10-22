import { LucidMembershipDirectory } from '#core/membership/index'
import { LucidTenantStore } from '#platform/tenants/infrastructure/lucid_tenant_store'
import {
  ListMyTenants,
  ResolveTenantContext,
} from '#platform/tenants/application/context_use_cases'

function build() {
  const tenants = new LucidTenantStore()
  const memberships = new LucidMembershipDirectory()
  return {
    resolveTenantContext: new ResolveTenantContext(tenants, memberships),
    listMyTenants: new ListMyTenants(tenants, memberships),
  }
}

let instance: ReturnType<typeof build> | undefined

export const tenantServices = () => (instance ??= build())
