import type { TenantScope } from '#core/tenancy/index'
import type { PermissionDefinition } from '#core/permissions/domain/catalog'
import type {
  AccessPolicy,
  FieldRule,
  Grant,
  PolicyEffect,
  PolicyStatus,
} from '#core/permissions/domain/decision'
import type { Condition } from '#core/permissions/domain/condition'

export interface PermissionRecord extends PermissionDefinition {
  id: string
}

/** Catálogo global de permissões (igual em todos os tenants). */
export interface PermissionCatalogStore {
  sync(definitions: readonly PermissionDefinition[]): Promise<void>
  list(): Promise<PermissionRecord[]>
}

export interface RoleView {
  id: string
  code: string
  name: string
  description: string | null
  isSystem: boolean
  version: number
  permissionCodes: string[]
}

export interface AssignmentView {
  id: string
  membershipId: string
  roleId: string
  organizationUnitId: string | null
  validFrom: Date | null
  validUntil: Date | null
}

export interface PolicyInput {
  name: string
  resource: string
  action: string
  effect: PolicyEffect
  condition: Condition | null
  priority: number
  status: PolicyStatus
  fieldRules: FieldRule[]
}

export interface PolicyView extends AccessPolicy {
  version: number
}

/** Dados de autorização do tenant. Todas as operações correm no âmbito (transacção + RLS) do contexto. */
export interface IamStore {
  effectiveGrants(scope: TenantScope, membershipId: string, now: Date): Promise<Grant[]>
  activePolicies(scope: TenantScope): Promise<AccessPolicy[]>
  /** Serializa as alterações que podem retirar administradores (lock por tenant até ao fim da transacção). */
  lockAdmins(scope: TenantScope): Promise<void>
  /** Memberships ACTIVE com uma atribuição válida, sem limite de unidade, de um papel que concede `iam.manage`. */
  countActiveAdmins(scope: TenantScope, now: Date): Promise<number>

  listRoles(scope: TenantScope): Promise<RoleView[]>
  findRole(scope: TenantScope, id: string): Promise<RoleView | null>
  findRoleByCode(scope: TenantScope, code: string): Promise<RoleView | null>
  /** `null` se o código já existir neste tenant. Os códigos de permissão já vêm validados. */
  insertRole(
    scope: TenantScope,
    input: {
      code: string
      name: string
      description: string | null
      isSystem: boolean
      permissionCodes: string[]
    }
  ): Promise<RoleView | null>
  updateRole(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: { name?: string; description?: string | null }
  ): Promise<RoleView>
  setRolePermissions(scope: TenantScope, roleId: string, permissionCodes: string[]): Promise<void>
  /** `IN_USE` se ainda houver atribuições. */
  deleteRole(scope: TenantScope, id: string): Promise<'DELETED' | 'IN_USE'>
  membershipsWithRole(scope: TenantScope, roleId: string): Promise<string[]>

  listAssignments(scope: TenantScope, membershipId?: string): Promise<AssignmentView[]>
  /** `null` se a mesma atribuição já existir. */
  insertAssignment(
    scope: TenantScope,
    input: {
      membershipId: string
      roleId: string
      organizationUnitId: string | null
      validFrom: Date | null
      validUntil: Date | null
    }
  ): Promise<AssignmentView | null>
  /** Devolve a membership afectada, ou `null` se a atribuição não existir. */
  deleteAssignment(scope: TenantScope, id: string): Promise<string | null>

  listPolicies(scope: TenantScope): Promise<PolicyView[]>
  findPolicy(scope: TenantScope, id: string): Promise<PolicyView | null>
  insertPolicy(scope: TenantScope, input: PolicyInput): Promise<PolicyView>
  updatePolicy(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<PolicyInput>
  ): Promise<PolicyView>
}
