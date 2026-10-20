/**
 * API pública do módulo de multi-tenancy. Outros módulos importam **apenas** daqui
 * (`#core/tenancy/index`), nunca dos ficheiros internos.
 */
export {
  ACTOR_TYPES,
  InvalidTenantContextError,
  MissingTenantContextError,
  TenantContext,
  isUuid,
  type ActorType,
  type TenantContextProps,
  type UnitScope,
} from '#core/tenancy/domain/tenant_context'
export type { TenantScope, TenantUnitOfWork } from '#core/tenancy/application/tenant_unit_of_work'
export {
  TenantContextStore,
  tenantContextStore,
} from '#core/tenancy/infrastructure/tenant_context_store'
export {
  LucidTenantDatabase,
  LucidTenantScope,
} from '#core/tenancy/infrastructure/lucid_tenant_database'
export {
  RESERVED_COLUMNS,
  ReservedColumnError,
  TenantRepository,
  type ListOptions,
  type TenantRow,
  type WritableValues,
} from '#core/tenancy/infrastructure/tenant_repository'
