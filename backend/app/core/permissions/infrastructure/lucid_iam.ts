import db from '@adonisjs/lucid/services/db'
import {
  LucidTenantScope,
  TenantRepository,
  type TenantRow,
  type TenantScope,
} from '#core/tenancy/index'
import type { PermissionDefinition } from '#core/permissions/domain/catalog'
import type { Condition } from '#core/permissions/domain/condition'
import type {
  FieldRule,
  Grant,
  PolicyEffect,
  PolicyStatus,
} from '#core/permissions/domain/decision'
import type {
  AssignmentView,
  IamStore,
  PermissionCatalogStore,
  PermissionRecord,
  PolicyInput,
  PolicyView,
  RoleView,
} from '#core/permissions/application/ports'

const conn = () => db.connection('runtime')

/** Catálogo global: sem contexto de tenant, só o que o código declara. Idempotente. */
export class LucidPermissionCatalog implements PermissionCatalogStore {
  async sync(definitions: readonly PermissionDefinition[]) {
    for (const def of definitions) {
      const [resource, action] = def.code.split('.')
      await conn().rawQuery(
        `insert into permissions (code, module_code, resource, action, description)
         values (?, ?, ?, ?, ?)
         on conflict (code) do update
           set module_code = excluded.module_code, description = excluded.description, updated_at = now()`,
        [def.code, def.moduleCode, resource, action, def.description]
      )
    }
  }

  async list() {
    const rows = await conn().from('permissions').orderBy('code')
    return rows.map((r): PermissionRecord => ({
      id: r.id,
      code: r.code,
      moduleCode: r.module_code,
      description: r.description,
    }))
  }
}

interface RoleRow extends TenantRow {
  code: string
  name: string
  description: string | null
  is_system: boolean
}
interface AssignmentRow extends TenantRow {
  membership_id: string
  role_id: string
  organization_unit_id: string | null
  valid_from: Date | null
  valid_until: Date | null
}
interface PolicyRow extends TenantRow {
  name: string
  resource: string
  action: string
  effect: PolicyEffect
  condition_ast: Condition | null
  priority: number
  status: PolicyStatus
  field_rules: FieldRule[]
}

class Roles extends TenantRepository<RoleRow> {
  protected readonly table = 'roles'
}
class Policies extends TenantRepository<PolicyRow> {
  protected readonly table = 'access_policies'
}

const toAssignment = (r: AssignmentRow): AssignmentView => ({
  id: r.id,
  membershipId: r.membership_id,
  roleId: r.role_id,
  organizationUnitId: r.organization_unit_id,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
})

const toPolicy = (r: PolicyRow): PolicyView => ({
  id: r.id,
  name: r.name,
  resource: r.resource,
  action: r.action,
  effect: r.effect,
  condition: r.condition_ast,
  priority: r.priority,
  status: r.status,
  fieldRules: r.field_rules,
  version: r.version,
})

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const json = (value: unknown) => JSON.stringify(value)

export class LucidIamStore implements IamStore {
  private readonly roles = new Roles()
  private readonly policies = new Policies()

  // --- leitura para decisões -------------------------------------------------------------------

  async effectiveGrants(scope: TenantScope, membershipId: string, now: Date) {
    const result = await trxOf(scope).rawQuery(
      `select p.code as permission_code, r.id as role_id, r.code as role_code,
              a.id as assignment_id, a.organization_unit_id as unit_id
         from role_assignments a
         join roles r on r.tenant_id = a.tenant_id and r.id = a.role_id
         join role_permissions rp on rp.tenant_id = a.tenant_id and rp.role_id = r.id
         join permissions p on p.id = rp.permission_id
        where a.tenant_id = ? and a.membership_id = ?
          and (a.valid_from is null or a.valid_from <= ?)
          and (a.valid_until is null or a.valid_until > ?)`,
      [tenantOf(scope), membershipId, now, now]
    )
    return (result.rows as Record<string, string | null>[]).map((r): Grant => ({
      permissionCode: r.permission_code as string,
      roleId: r.role_id as string,
      roleCode: r.role_code as string,
      assignmentId: r.assignment_id as string,
      unitId: r.unit_id,
    }))
  }

  async lockAdmins(scope: TenantScope) {
    await trxOf(scope).rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `iam-admins:${tenantOf(scope)}`,
    ])
  }

  async countActiveAdmins(scope: TenantScope, now: Date) {
    // Leitura (só) da tabela de memberships para saber quem está activo.
    const result = await trxOf(scope).rawQuery(
      `select count(distinct m.id)::int as total
         from tenant_memberships m
         join role_assignments a on a.tenant_id = m.tenant_id and a.membership_id = m.id
         join role_permissions rp on rp.tenant_id = a.tenant_id and rp.role_id = a.role_id
         join permissions p on p.id = rp.permission_id and p.code = 'iam.manage'
        where m.tenant_id = ? and m.status = 'ACTIVE' and a.organization_unit_id is null
          and (a.valid_from is null or a.valid_from <= ?)
          and (a.valid_until is null or a.valid_until > ?)`,
      [tenantOf(scope), now, now]
    )
    return (result.rows as { total: number }[])[0].total
  }

  async activePolicies(scope: TenantScope) {
    const rows = await trxOf(scope)
      .from('access_policies')
      .where({ tenant_id: tenantOf(scope), status: 'ACTIVE' })
    return (rows as PolicyRow[]).map(toPolicy)
  }

  // --- papéis ----------------------------------------------------------------------------------

  private async withPermissions(scope: TenantScope, roles: RoleRow[]): Promise<RoleView[]> {
    if (roles.length === 0) return []
    const rows = await trxOf(scope)
      .from('role_permissions as rp')
      .join('permissions as p', 'p.id', 'rp.permission_id')
      .where('rp.tenant_id', tenantOf(scope))
      .whereIn(
        'rp.role_id',
        roles.map((r) => r.id)
      )
      .select('rp.role_id', 'p.code')
    const byRole = new Map<string, string[]>()
    for (const row of rows) byRole.set(row.role_id, [...(byRole.get(row.role_id) ?? []), row.code])
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      isSystem: r.is_system,
      version: r.version,
      permissionCodes: (byRole.get(r.id) ?? []).sort(),
    }))
  }

  async listRoles(scope: TenantScope) {
    const rows = await this.roles.list(scope, { limit: 100 })
    return this.withPermissions(scope, rows)
  }

  async findRole(scope: TenantScope, id: string) {
    const row = await this.roles.findById(scope, id)
    if (!row) return null
    const [view] = await this.withPermissions(scope, [row])
    return view
  }

  async findRoleByCode(scope: TenantScope, code: string) {
    const row = await trxOf(scope)
      .from('roles')
      .where({ tenant_id: tenantOf(scope), code })
      .first()
    if (!row) return null
    const [view] = await this.withPermissions(scope, [row as RoleRow])
    return view
  }

  async insertRole(
    scope: TenantScope,
    input: {
      code: string
      name: string
      description: string | null
      isSystem: boolean
      permissionCodes: string[]
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into roles (tenant_id, code, name, description, is_system, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, code) do nothing
       returning *`,
      [
        tenantOf(scope),
        input.code,
        input.name,
        input.description as string,
        input.isSystem,
        (scope as LucidTenantScope).context.membershipId as string,
        (scope as LucidTenantScope).context.membershipId as string,
      ]
    )
    const [row] = result.rows as RoleRow[]
    if (!row) return null
    await this.setRolePermissions(scope, row.id, input.permissionCodes)
    return (await this.findRole(scope, row.id)) as RoleView
  }

  async updateRole(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: { name?: string; description?: string | null }
  ) {
    await this.roles.update(scope, id, expectedVersion, values)
    return (await this.findRole(scope, id)) as RoleView
  }

  async setRolePermissions(scope: TenantScope, roleId: string, permissionCodes: string[]) {
    const trx = trxOf(scope)
    const tenantId = tenantOf(scope)
    await trx.from('role_permissions').where({ tenant_id: tenantId, role_id: roleId }).delete()
    if (permissionCodes.length === 0) return
    await trx.rawQuery(
      `insert into role_permissions (tenant_id, role_id, permission_id)
       select ?, ?, p.id from permissions p where p.code = any(?)`,
      [tenantId, roleId, permissionCodes]
    )
  }

  async deleteRole(scope: TenantScope, id: string) {
    const trx = trxOf(scope)
    const tenantId = tenantOf(scope)
    const used = await trx
      .from('role_assignments')
      .where({ tenant_id: tenantId, role_id: id })
      .first()
    if (used) return 'IN_USE'
    await trx.from('roles').where({ tenant_id: tenantId, id }).delete()
    return 'DELETED'
  }

  async membershipsWithRole(scope: TenantScope, roleId: string) {
    const rows = await trxOf(scope)
      .from('role_assignments')
      .where({ tenant_id: tenantOf(scope), role_id: roleId })
      .distinct('membership_id')
    return rows.map((r) => r.membership_id as string)
  }

  // --- atribuições -----------------------------------------------------------------------------

  async listAssignments(scope: TenantScope, membershipId?: string) {
    const query = trxOf(scope)
      .from('role_assignments')
      .where('tenant_id', tenantOf(scope))
      .orderBy('created_at')
      .limit(200)
    if (membershipId) query.where('membership_id', membershipId)
    return ((await query) as AssignmentRow[]).map(toAssignment)
  }

  async insertAssignment(
    scope: TenantScope,
    input: {
      membershipId: string
      roleId: string
      organizationUnitId: string | null
      validFrom: Date | null
      validUntil: Date | null
    }
  ) {
    const context = (scope as LucidTenantScope).context
    const result = await trxOf(scope).rawQuery(
      `insert into role_assignments
         (tenant_id, membership_id, role_id, organization_unit_id, valid_from, valid_until,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning *`,
      [
        context.tenantId,
        input.membershipId,
        input.roleId,
        input.organizationUnitId as string,
        input.validFrom as Date,
        input.validUntil as Date,
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    const [row] = result.rows as AssignmentRow[]
    return row ? toAssignment(row) : null
  }

  async deleteAssignment(scope: TenantScope, id: string) {
    const rows = await trxOf(scope)
      .from('role_assignments')
      .where({ tenant_id: tenantOf(scope), id })
      .delete()
      .returning('membership_id')
    return rows.length > 0 ? (rows[0].membership_id as string) : null
  }

  // --- políticas -------------------------------------------------------------------------------

  async listPolicies(scope: TenantScope) {
    const rows = await this.policies.list(scope, { limit: 100 })
    return rows.map(toPolicy)
  }

  async findPolicy(scope: TenantScope, id: string) {
    const row = await this.policies.findById(scope, id)
    return row ? toPolicy(row) : null
  }

  async insertPolicy(scope: TenantScope, input: PolicyInput) {
    const row = await this.policies.insert(scope, {
      name: input.name,
      resource: input.resource,
      action: input.action,
      effect: input.effect,
      condition_ast: input.condition === null ? null : (json(input.condition) as never),
      priority: input.priority,
      status: input.status,
      field_rules: json(input.fieldRules) as never,
    })
    return toPolicy(row)
  }

  async updatePolicy(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<PolicyInput>
  ) {
    const { condition, fieldRules, ...plain } = values
    const row = await this.policies.update(scope, id, expectedVersion, {
      ...plain,
      ...(condition !== undefined
        ? { condition_ast: condition === null ? null : (json(condition) as never) }
        : {}),
      ...(fieldRules !== undefined ? { field_rules: json(fieldRules) as never } : {}),
    })
    return toPolicy(row)
  }
}
