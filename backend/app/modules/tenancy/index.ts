/** API pública do módulo de tenancy: os outros módulos importam só daqui. */
export type { Tenant, TenantStatus } from '#modules/tenancy/domain/tenant'
export type { TenantContext } from '#modules/tenancy/domain/tenant_context'
export { MissingTenantContextError } from '#modules/tenancy/domain/tenant_context'
export { runInTenant, type TenantScope } from '#modules/tenancy/infrastructure/tenant_database'
export { TenantRepository } from '#modules/tenancy/infrastructure/tenant_repository'
export { userTenantLinks } from '#modules/tenancy/infrastructure/membership_lookup'
export { PLATFORM_TABLES, FRAMEWORK_TABLES } from '#modules/tenancy/domain/platform_tables'
export {
  MembershipRepository,
  type Member,
  type MembershipStatus,
} from '#modules/tenancy/infrastructure/membership_repository'
export { normalizeTenant } from '#modules/tenancy/domain/tenant'
