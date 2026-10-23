/** API pública do módulo de tenants (plano de controlo). Outros módulos importam **apenas** daqui. */
export {
  TENANT_STATUSES,
  canTransition,
  isOperational,
  type Tenant,
  type TenantDomain,
  type TenantStatus,
} from '#platform/tenants/domain/tenant'
export {
  ChangeTenantStatus,
  CreateTenant,
  RegisterTenantDomain,
  VerifyTenantDomain,
} from '#platform/tenants/application/use_cases'
export { LucidTenantStore } from '#platform/tenants/infrastructure/lucid_tenant_store'
export {
  ListMyTenants,
  ResolveTenantContext,
  type MyTenant,
  type ResolvedTenantContext,
  type TenantSelector,
} from '#platform/tenants/application/context_use_cases'
export {
  addMemberByEmail,
  changeMemberStatusByEmail,
} from '#platform/tenants/presentation/member_commands'
export { bootstrapTenantAdmin, syncIam } from '#platform/tenants/presentation/iam_commands'
export { tenantServices } from '#platform/tenants/presentation/composition'
