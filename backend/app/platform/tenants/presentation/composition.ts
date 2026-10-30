import { LucidMembershipDirectory } from '#core/membership/index'
import { organizationServices } from '#core/organization/index'
import { memberServices } from '#core/members/index'
import { billingServices } from '#platform/billing/index'
import { isOperational } from '#platform/tenants/domain/tenant'
import { LucidTenantStore } from '#platform/tenants/infrastructure/lucid_tenant_store'
import {
  ListMyTenants,
  ResolveTenantContext,
} from '#platform/tenants/application/context_use_cases'

function build() {
  const tenants = new LucidTenantStore()
  const memberships = new LucidMembershipDirectory()
  return {
    resolveTenantContext: new ResolveTenantContext(tenants, memberships, {
      resolve: (context, membershipId) =>
        organizationServices().resolveUnitScope.execute(context, membershipId),
    }),
    /** A aceitação de convites usa o estado e a quota do tenant (plano de controlo). */
    acceptInvitation: memberServices().acceptInvitation(
      {
        isOperational: async (tenantId) => {
          const tenant = await tenants.findById(tenantId)
          return tenant !== null && isOperational(tenant.status)
        },
      },
      { limit: (tenantId) => billingServices().resolveLimit.execute(tenantId, 'members') }
    ),
    listMyTenants: new ListMyTenants(tenants, memberships),
  }
}

let instance: ReturnType<typeof build> | undefined

export const tenantServices = () => (instance ??= build())
