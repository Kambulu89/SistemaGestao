import { ApiError } from '#shared/http/api_error'
import { runInTenant, type TenantContext } from '#modules/tenancy/index'
import { normalizeRole, type Role } from '#modules/rbac/domain/role'
import { RbacRepository } from '#modules/rbac/infrastructure/rbac_repository'
import { effectivePermissions } from '#modules/rbac/application/authorization'

const repository = new RbacRepository()

type RoleInput = {
  code?: unknown
  name?: unknown
  description?: unknown
  status?: unknown
  permissionCodes?: unknown
}

/** Só se concede o que se tem: um perfil não pode levar permissões que o actor não tenha com âmbito de empresa. */
async function assertGrantable(
  scope: Parameters<typeof effectivePermissions>[0],
  codes: readonly string[]
) {
  const own = await effectivePermissions(scope)
  const missing = codes.filter((code) => !own.tenant.has(code))
  if (missing.length > 0) {
    throw new ApiError(403, 'PRIVILEGE_ESCALATION', 'Não pode conceder permissões que não tem.', [
      ...missing.map((code) => ({ path: 'permissionCodes', code: 'NOT_HELD', message: code })),
    ])
  }
}

export class RoleService {
  list(context: TenantContext): Promise<Role[]> {
    return runInTenant(context, (scope) => repository.listRoles(scope))
  }

  get(context: TenantContext, id: string): Promise<Role> {
    return runInTenant(context, async (scope) => {
      const role = await repository.findRole(scope, id)
      if (!role) throw ApiError.notFound()
      return role
    })
  }

  create(context: TenantContext, input: RoleInput): Promise<Role> {
    const { values, issues } = normalizeRole(input, null)
    if (!values) throw ApiError.validation(issues)
    return runInTenant(context, async (scope) => {
      await assertGrantable(scope, values.permissionCodes)
      return repository.insertRole(scope, values)
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: RoleInput & { expectedVersion: number }
  ): Promise<Role> {
    return runInTenant(context, async (scope) => {
      const current = await repository.findRole(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.isSystem)
        throw ApiError.conflict('SYSTEM_ROLE', 'Os perfis de sistema não se alteram.')
      const { values, issues } = normalizeRole(input, current)
      if (!values) throw ApiError.validation(issues)
      // Só as permissões acrescentadas exigem que o actor as tenha; retirar é sempre possível.
      await assertGrantable(
        scope,
        values.permissionCodes.filter((code) => !current.permissionCodes.includes(code))
      )
      return repository.updateRole(scope, id, input.expectedVersion, values)
    })
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return runInTenant(context, async (scope) => {
      const current = await repository.findRole(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.isSystem)
        throw ApiError.conflict('SYSTEM_ROLE', 'Os perfis de sistema não se eliminam.')
      if (await repository.roleInUse(scope, id)) {
        throw ApiError.conflict(
          'ROLE_IN_USE',
          'O perfil está atribuído a membros: retire-o primeiro ou desactive-o.'
        )
      }
      await repository.deleteRole(scope, id)
    })
  }
}
