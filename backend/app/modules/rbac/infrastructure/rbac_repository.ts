import { ApiError } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import type { TenantScope } from '#modules/tenancy/index'
import type { Role, RoleStatus, RoleValues } from '#modules/rbac/domain/role'
import type { ScopeType } from '#modules/rbac/domain/permissions'

interface RoleRow {
  id: string
  code: string
  name: string
  description: string | null
  is_system: boolean
  status: RoleStatus
  version: number
  permission_codes: string[] | null
}

const ROLE_SELECT = `
  select r.id, r.code, r.name, r.description, r.is_system, r.status, r.version,
         coalesce(array_agg(rp.permission_code order by rp.permission_code)
                  filter (where rp.permission_code is not null), '{}') as permission_codes
    from roles r
    left join role_permissions rp on rp.tenant_id = r.tenant_id and rp.role_id = r.id`

const toRole = (r: RoleRow): Role => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  isSystem: r.is_system,
  status: r.status,
  version: r.version,
  permissionCodes: r.permission_codes ?? [],
})

export interface Assignment {
  id: string
  membershipId: string
  roleId: string
  roleCode: string
  scopeType: ScopeType
}

/** Perfis e atribuições do tenant em contexto (a RLS garante o tenant; os filtros repetem-no por clareza). */
export class RbacRepository {
  async listRoles({ trx, context }: TenantScope): Promise<Role[]> {
    const result = await trx.rawQuery(
      `${ROLE_SELECT} where r.tenant_id = ? group by r.id order by r.name`,
      [context.tenantId]
    )
    return (result.rows as RoleRow[]).map(toRole)
  }

  async findRole({ trx, context }: TenantScope, id: string, lock = false): Promise<Role | null> {
    if (lock)
      await trx.rawQuery('select id from roles where tenant_id = ? and id = ? for update', [
        context.tenantId,
        id,
      ])
    const result = await trx.rawQuery(
      `${ROLE_SELECT} where r.tenant_id = ? and r.id = ? group by r.id`,
      [context.tenantId, id]
    )
    const [row] = result.rows as RoleRow[]
    return row ? toRole(row) : null
  }

  async findRoleByCode({ trx, context }: TenantScope, code: string): Promise<Role | null> {
    const result = await trx.rawQuery(
      `${ROLE_SELECT} where r.tenant_id = ? and r.code = ? group by r.id`,
      [context.tenantId, code]
    )
    const [row] = result.rows as RoleRow[]
    return row ? toRole(row) : null
  }

  async insertRole(scope: TenantScope, v: RoleValues, isSystem = false): Promise<Role> {
    const { trx, context } = scope
    try {
      await trx.rawQuery('savepoint role_insert')
      const result = await trx.rawQuery(
        `insert into roles (tenant_id, code, name, description, status, is_system, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          v.code,
          v.name,
          v.description,
          v.status,
          isSystem,
          context.userId,
          context.userId,
        ] as never[]
      )
      await trx.rawQuery('release savepoint role_insert')
      const id = (result.rows[0] as { id: string }).id
      await this.replacePermissions(scope, id, v.permissionCodes)
      return (await this.findRole(scope, id))!
    } catch (error) {
      if (constraintOf(error) === 'roles_code_unique') {
        await trx.rawQuery('rollback to savepoint role_insert')
        throw ApiError.conflict('ROLE_CODE_TAKEN', 'Já existe um perfil com este código.')
      }
      throw error
    }
  }

  async updateRole(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: RoleValues
  ): Promise<Role> {
    const { trx, context } = scope
    const result = await trx.rawQuery(
      `update roles set name = ?, description = ?, status = ?, updated_by = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.name,
        v.description,
        v.status,
        context.userId,
        context.tenantId,
        id,
        expectedVersion,
      ] as never[]
    )
    if (result.rows.length === 0) {
      const current = await this.findRole(scope, id)
      if (!current) throw ApiError.notFound()
      throw ApiError.versionConflict(current.version)
    }
    await this.replacePermissions(scope, id, v.permissionCodes)
    return (await this.findRole(scope, id))!
  }

  async replacePermissions(
    { trx, context }: TenantScope,
    roleId: string,
    codes: readonly string[]
  ) {
    await trx.rawQuery('delete from role_permissions where tenant_id = ? and role_id = ?', [
      context.tenantId,
      roleId,
    ])
    for (const code of codes) {
      await trx.rawQuery(
        `insert into role_permissions (tenant_id, role_id, permission_code, created_by) values (?, ?, ?, ?)`,
        [context.tenantId, roleId, code, context.userId]
      )
    }
  }

  async deleteRole({ trx, context }: TenantScope, id: string) {
    await trx.rawQuery('delete from roles where tenant_id = ? and id = ?', [context.tenantId, id])
  }

  async roleInUse({ trx, context }: TenantScope, roleId: string): Promise<boolean> {
    const result = await trx.rawQuery(
      'select 1 from membership_roles where tenant_id = ? and role_id = ? limit 1',
      [context.tenantId, roleId]
    )
    return result.rows.length > 0
  }

  async assignments(
    { trx, context }: TenantScope,
    membershipIds?: readonly string[]
  ): Promise<Assignment[]> {
    const result = await trx.rawQuery(
      `select mr.id, mr.membership_id, mr.role_id, r.code as role_code, mr.scope_type
         from membership_roles mr join roles r on r.tenant_id = mr.tenant_id and r.id = mr.role_id
        where mr.tenant_id = ? ${membershipIds ? 'and mr.membership_id = any(?::uuid[])' : ''}
        order by r.code`,
      (membershipIds ? [context.tenantId, membershipIds] : [context.tenantId]) as never[]
    )
    return (
      result.rows as {
        id: string
        membership_id: string
        role_id: string
        role_code: string
        scope_type: ScopeType
      }[]
    ).map((r) => ({
      id: r.id,
      membershipId: r.membership_id,
      roleId: r.role_id,
      roleCode: r.role_code,
      scopeType: r.scope_type,
    }))
  }

  async assign(
    { trx, context }: TenantScope,
    membershipId: string,
    roleId: string,
    scopeType: ScopeType
  ) {
    await trx.rawQuery(
      `insert into membership_roles (tenant_id, membership_id, role_id, scope_type, created_by)
       values (?, ?, ?, ?, ?) on conflict (tenant_id, membership_id, role_id, scope_type) do nothing`,
      [context.tenantId, membershipId, roleId, scopeType, context.userId]
    )
  }

  async unassign({ trx, context }: TenantScope, assignmentId: string): Promise<boolean> {
    const result = await trx.rawQuery(
      'delete from membership_roles where tenant_id = ? and id = ? returning id',
      [context.tenantId, assignmentId]
    )
    return result.rows.length > 0
  }

  /** Permissões efectivas de uma membership activa, por âmbito, só de perfis activos. */
  async effectivePermissions({ trx, context }: TenantScope, membershipId: string) {
    const result = await trx.rawQuery(
      `select distinct rp.permission_code, mr.scope_type
         from membership_roles mr
         join tenant_memberships m on m.tenant_id = mr.tenant_id and m.id = mr.membership_id and m.status = 'ACTIVE'
         join roles r on r.tenant_id = mr.tenant_id and r.id = mr.role_id and r.status = 'ACTIVE'
         join role_permissions rp on rp.tenant_id = r.tenant_id and rp.role_id = r.id
        where mr.tenant_id = ? and mr.membership_id = ?`,
      [context.tenantId, membershipId]
    )
    return result.rows as { permission_code: string; scope_type: ScopeType }[]
  }

  /** Memberships activas que têm o perfil indicado (protecção do último administrador). */
  async activeHoldersOf({ trx, context }: TenantScope, roleCode: string): Promise<string[]> {
    const result = await trx.rawQuery(
      `select m.id from membership_roles mr
         join roles r on r.tenant_id = mr.tenant_id and r.id = mr.role_id and r.code = ?
         join tenant_memberships m on m.tenant_id = mr.tenant_id and m.id = mr.membership_id and m.status = 'ACTIVE'
        where mr.tenant_id = ? and mr.scope_type = 'TENANT'
        for update of mr`,
      [roleCode, context.tenantId]
    )
    return [...new Set((result.rows as { id: string }[]).map((r) => r.id))]
  }
}
