import { ApiError } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { RbacRepository } from '#modules/rbac/infrastructure/rbac_repository'
import type { ScopeType } from '#modules/rbac/domain/permissions'

export interface EffectivePermissions {
  /** Permissões com âmbito de toda a empresa. */
  tenant: Set<string>
  /** Permissões só sobre registos próprios. */
  own: Set<string>
}

const repository = new RbacRepository()

/**
 * Autorização no servidor: negar por omissão. Uma permissão com âmbito `TENANT` vale para toda a empresa; com âmbito
 * `OWN` só para registos do próprio (verificado pelo caso de uso que conhece o dono do registo).
 */
export async function effectivePermissions(
  scope: TenantScope,
  membershipId?: string
): Promise<EffectivePermissions> {
  const rows = await repository.effectivePermissions(
    scope,
    membershipId ?? scope.context.membershipId
  )
  const result: EffectivePermissions = { tenant: new Set(), own: new Set() }
  for (const row of rows)
    (row.scope_type === 'TENANT' ? result.tenant : result.own).add(row.permission_code)
  return result
}

export function permissionsFor(context: TenantContext) {
  return runInTenant(context, (scope) => effectivePermissions(scope))
}

/** Lança 403 se o actor não tem a permissão com âmbito de empresa (ou próprio, quando `allowOwn`). */
export async function assertCan(
  scope: TenantScope,
  permission: string,
  allowOwn = false
): Promise<ScopeType> {
  const granted = await effectivePermissions(scope)
  if (granted.tenant.has(permission)) return 'TENANT'
  if (allowOwn && granted.own.has(permission)) return 'OWN'
  throw ApiError.forbidden()
}

/** Onde uma permissão vale para a membership em contexto (negar por omissão quando tudo vem vazio). */
export interface PermissionScope {
  tenant: boolean
  own: boolean
  legalEntityIds: Set<string>
  branchIds: Set<string>
  /** Departamentos atribuídos e todos os seus descendentes. */
  departmentIds: Set<string>
}

export async function permissionScope(
  scope: TenantScope,
  permission: string,
  membershipId?: string
): Promise<PermissionScope> {
  const rows = await repository.scopedGrants(
    scope,
    membershipId ?? scope.context.membershipId,
    permission
  )
  const result: PermissionScope = {
    tenant: false,
    own: false,
    legalEntityIds: new Set(),
    branchIds: new Set(),
    departmentIds: new Set(),
  }
  for (const row of rows) {
    if (row.kind === 'DEPARTMENT_TREE') result.departmentIds.add(row.target!)
    else if (row.scope_type === 'TENANT') result.tenant = true
    else if (row.scope_type === 'OWN') result.own = true
    else if (row.scope_type === 'LEGAL_ENTITY') result.legalEntityIds.add(row.target!)
    else if (row.scope_type === 'BRANCH') result.branchIds.add(row.target!)
  }
  return result
}
