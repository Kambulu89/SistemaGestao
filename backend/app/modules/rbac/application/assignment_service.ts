import { ApiError } from '#shared/http/api_error'
import type { TenantScope } from '#modules/tenancy/index'
import { RbacRepository } from '#modules/rbac/infrastructure/rbac_repository'
import { effectivePermissions } from '#modules/rbac/application/authorization'
import {
  SCOPE_TYPES,
  TARGETED_SCOPES,
  TENANT_ADMIN_ROLE,
  type ScopeType,
} from '#modules/rbac/domain/permissions'

const repository = new RbacRepository()

/**
 * Atribuição de perfis a membros, dentro da transacção de quem chama (o módulo `members`). Regras:
 *  - ninguém altera os próprios perfis;
 *  - só se atribui um perfil activo cujas permissões o actor tem com âmbito de empresa;
 *  - o último administrador activo da empresa não perde o perfil.
 */
export class AssignmentService {
  async assign(
    scope: TenantScope,
    membershipId: string,
    roleId: string,
    scopeType: unknown = 'TENANT',
    scopeId: string | null = null
  ) {
    if (membershipId === scope.context.membershipId) {
      throw ApiError.forbidden('SELF_ASSIGNMENT', 'Não pode alterar os seus próprios perfis.')
    }
    if (!SCOPE_TYPES.includes(scopeType as ScopeType)) {
      throw ApiError.validation([
        { path: 'scopeType', code: 'INVALID_SCOPE', message: `Âmbito: ${SCOPE_TYPES.join(', ')}.` },
      ])
    }
    const targeted = TARGETED_SCOPES.includes(scopeType as ScopeType)
    if (targeted !== Boolean(scopeId)) {
      throw ApiError.validation([
        {
          path: 'scopeId',
          code: targeted ? 'SCOPE_TARGET_REQUIRED' : 'SCOPE_TARGET_NOT_ALLOWED',
          message: targeted
            ? 'Indique a entidade legal, filial ou departamento do âmbito.'
            : 'Este âmbito não leva alvo.',
        },
      ])
    }
    const role = await repository.findRole(scope, roleId)
    if (!role) {
      throw ApiError.validation([
        { path: 'roleId', code: 'UNKNOWN_ROLE', message: 'O perfil não existe.' },
      ])
    }
    if (role.status !== 'ACTIVE')
      throw ApiError.conflict('ROLE_INACTIVE', 'O perfil está inactivo.')
    const held = await effectivePermissions(scope)
    const missing = role.permissionCodes.filter((code) => !held.tenant.has(code))
    if (missing.length > 0) {
      throw new ApiError(
        403,
        'PRIVILEGE_ESCALATION',
        'Não pode atribuir um perfil com permissões que não tem.',
        [...missing.map((code) => ({ path: 'roleId', code: 'NOT_HELD', message: code }))]
      )
    }
    await repository.assign(scope, membershipId, roleId, scopeType as ScopeType, scopeId)
  }

  async unassign(scope: TenantScope, membershipId: string, assignmentId: string) {
    if (membershipId === scope.context.membershipId) {
      throw ApiError.forbidden('SELF_ASSIGNMENT', 'Não pode alterar os seus próprios perfis.')
    }
    const assignment = (await repository.assignments(scope, [membershipId])).find(
      (a) => a.id === assignmentId
    )
    if (!assignment) throw ApiError.notFound()
    if (assignment.roleCode === TENANT_ADMIN_ROLE && assignment.scopeType === 'TENANT') {
      await this.assertNotLastAdmin(scope, membershipId)
    }
    await repository.unassign(scope, assignmentId)
  }

  /** Bloqueia (FOR UPDATE) as atribuições de administrador para que dois pedidos simultâneos não removam ambos. */
  async assertNotLastAdmin(scope: TenantScope, membershipId: string) {
    const holders = await repository.activeHoldersOf(scope, TENANT_ADMIN_ROLE)
    if (holders.includes(membershipId) && holders.length <= 1) {
      throw ApiError.conflict('LAST_ADMIN', 'A empresa ficaria sem administrador activo.')
    }
  }

  assignments(scope: TenantScope, membershipIds?: readonly string[]) {
    return repository.assignments(scope, membershipIds)
  }
}
