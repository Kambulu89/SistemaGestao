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
