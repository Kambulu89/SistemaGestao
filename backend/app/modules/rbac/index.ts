/** API pública do RBAC. */
export { PERMISSIONS, TENANT_ADMIN_ROLE, type ScopeType } from '#modules/rbac/domain/permissions'
export type { Role } from '#modules/rbac/domain/role'
export {
  assertCan,
  effectivePermissions,
  permissionScope,
  permissionsFor,
  type PermissionScope,
} from '#modules/rbac/application/authorization'
export { AssignmentService } from '#modules/rbac/application/assignment_service'
export { bootstrapTenantAdmin, syncPermissionCatalog } from '#modules/rbac/application/catalog'
export type { Assignment } from '#modules/rbac/infrastructure/rbac_repository'
