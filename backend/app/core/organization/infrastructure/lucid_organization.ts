import {
  LucidTenantScope,
  TenantRepository,
  type TenantRow,
  type TenantScope,
} from '#core/tenancy/index'
import type {
  CostCenter,
  MembershipScope,
  Organization,
  OrganizationUnit,
  TeamMember,
  UnitType,
} from '#core/organization/domain/organization'
import type {
  CostCenterValues,
  OrganizationStore,
  OrganizationValues,
  UnitValues,
} from '#core/organization/application/ports'

interface OrganizationRow extends TenantRow {
  code: string
  legal_name: string
  trade_name: string | null
  country_code: string
  tax_id: string | null
  base_currency: string
  fiscal_year_start_month: number
  address_id: string | null
  active: boolean
}
interface UnitRow extends TenantRow {
  organization_id: string
  parent_id: string | null
  code: string
  name: string
  type: UnitType
  manager_membership_id: string | null
  timezone: string | null
  active: boolean
}
interface CostCenterRow extends TenantRow {
  organization_id: string
  parent_id: string | null
  code: string
  name: string
  responsible_membership_id: string | null
  active: boolean
}

class Organizations extends TenantRepository<OrganizationRow> {
  protected readonly table = 'organizations'
}
class Units extends TenantRepository<UnitRow> {
  protected readonly table = 'organization_units'
}
class CostCenters extends TenantRepository<CostCenterRow> {
  protected readonly table = 'cost_centers'
}

const toOrganization = (r: OrganizationRow): Organization => ({
  id: r.id,
  code: r.code,
  legalName: r.legal_name,
  tradeName: r.trade_name,
  countryCode: r.country_code,
  taxId: r.tax_id,
  baseCurrency: r.base_currency,
  fiscalYearStartMonth: r.fiscal_year_start_month,
  addressId: r.address_id,
  active: r.active,
  version: r.version,
})

const toUnit = (r: UnitRow): OrganizationUnit => ({
  id: r.id,
  organizationId: r.organization_id,
  parentId: r.parent_id,
  code: r.code,
  name: r.name,
  type: r.type,
  managerMembershipId: r.manager_membership_id,
  timezone: r.timezone,
  active: r.active,
  version: r.version,
})

const toCostCenter = (r: CostCenterRow): CostCenter => ({
  id: r.id,
  organizationId: r.organization_id,
  parentId: r.parent_id,
  code: r.code,
  name: r.name,
  responsibleMembershipId: r.responsible_membership_id,
  active: r.active,
  version: r.version,
})

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const contextOf = (scope: TenantScope) => (scope as LucidTenantScope).context
const tenantOf = (scope: TenantScope) => contextOf(scope).tenantId

/** Converte `undefined` em ausência de coluna e mapeia camelCase → snake_case. */
function columns(values: Record<string, unknown>, map: Record<string, string>) {
  const out: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(map)) {
    if (values[key] !== undefined) out[column] = values[key]
  }
  return out
}

const ORGANIZATION_COLUMNS = {
  legalName: 'legal_name',
  tradeName: 'trade_name',
  countryCode: 'country_code',
  taxId: 'tax_id',
  baseCurrency: 'base_currency',
  fiscalYearStartMonth: 'fiscal_year_start_month',
  addressId: 'address_id',
  active: 'active',
}
const UNIT_COLUMNS = {
  parentId: 'parent_id',
  name: 'name',
  type: 'type',
  managerMembershipId: 'manager_membership_id',
  timezone: 'timezone',
  active: 'active',
}
const COST_CENTER_COLUMNS = {
  parentId: 'parent_id',
  name: 'name',
  responsibleMembershipId: 'responsible_membership_id',
  active: 'active',
}

async function parentMap(scope: TenantScope, table: string, organizationId: string) {
  const rows = await trxOf(scope)
    .from(table)
    .where({ tenant_id: tenantOf(scope), organization_id: organizationId })
    .select('id', 'parent_id')
  return new Map<string, string | null>(
    rows.map((r) => [r.id as string, r.parent_id as string | null])
  )
}

export class LucidOrganizationStore implements OrganizationStore {
  private readonly organizations = new Organizations()
  private readonly units = new Units()
  private readonly costCenters = new CostCenters()

  async lockStructure(scope: TenantScope) {
    await trxOf(scope).rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `org-structure:${tenantOf(scope)}`,
    ])
  }

  // --- organizações ----------------------------------------------------------------------------

  async listOrganizations(scope: TenantScope) {
    const rows = await this.organizations.list(scope, { limit: 100 })
    return rows.map(toOrganization)
  }

  async findOrganization(scope: TenantScope, id: string) {
    const row = await this.organizations.findById(scope, id)
    return row ? toOrganization(row) : null
  }

  async insertOrganization(scope: TenantScope, values: OrganizationValues) {
    const context = contextOf(scope)
    const result = await trxOf(scope).rawQuery(
      `insert into organizations
         (tenant_id, code, legal_name, trade_name, country_code, tax_id, base_currency,
          fiscal_year_start_month, address_id, active, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, code) do nothing
       returning *`,
      [
        context.tenantId,
        values.code,
        values.legalName,
        values.tradeName as string,
        values.countryCode,
        values.taxId as string,
        values.baseCurrency,
        values.fiscalYearStartMonth,
        values.addressId as string,
        values.active,
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    const [row] = result.rows as OrganizationRow[]
    return row ? toOrganization(row) : null
  }

  async updateOrganization(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<OrganizationValues>
  ) {
    const row = await this.organizations.update(
      scope,
      id,
      expectedVersion,
      columns(values, ORGANIZATION_COLUMNS) as never
    )
    return toOrganization(row)
  }

  // --- unidades --------------------------------------------------------------------------------

  async listUnits(scope: TenantScope, organizationId?: string) {
    const query = trxOf(scope)
      .from('organization_units')
      .where('tenant_id', tenantOf(scope))
      .orderBy([{ column: 'organization_id' }, { column: 'code' }])
      .limit(500)
    if (organizationId) query.where('organization_id', organizationId)
    return ((await query) as UnitRow[]).map(toUnit)
  }

  async findUnit(scope: TenantScope, id: string) {
    const row = await this.units.findById(scope, id)
    return row ? toUnit(row) : null
  }

  async insertUnit(scope: TenantScope, values: UnitValues) {
    const context = contextOf(scope)
    const result = await trxOf(scope).rawQuery(
      `insert into organization_units
         (tenant_id, organization_id, parent_id, code, name, type, manager_membership_id, timezone, active,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, organization_id, code) do nothing
       returning *`,
      [
        context.tenantId,
        values.organizationId,
        values.parentId as string,
        values.code,
        values.name,
        values.type,
        values.managerMembershipId as string,
        values.timezone as string,
        values.active,
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    const [row] = result.rows as UnitRow[]
    return row ? toUnit(row) : null
  }

  async updateUnit(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<Omit<UnitValues, 'organizationId' | 'code'>>
  ) {
    const row = await this.units.update(
      scope,
      id,
      expectedVersion,
      columns(values, UNIT_COLUMNS) as never
    )
    return toUnit(row)
  }

  unitParents(scope: TenantScope, organizationId: string) {
    return parentMap(scope, 'organization_units', organizationId)
  }

  // --- centros de custo ------------------------------------------------------------------------

  async listCostCenters(scope: TenantScope, organizationId?: string) {
    const query = trxOf(scope)
      .from('cost_centers')
      .where('tenant_id', tenantOf(scope))
      .orderBy([{ column: 'organization_id' }, { column: 'code' }])
      .limit(500)
    if (organizationId) query.where('organization_id', organizationId)
    return ((await query) as CostCenterRow[]).map(toCostCenter)
  }

  async findCostCenter(scope: TenantScope, id: string) {
    const row = await this.costCenters.findById(scope, id)
    return row ? toCostCenter(row) : null
  }

  async insertCostCenter(scope: TenantScope, values: CostCenterValues) {
    const context = contextOf(scope)
    const result = await trxOf(scope).rawQuery(
      `insert into cost_centers
         (tenant_id, organization_id, parent_id, code, name, responsible_membership_id, active,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, organization_id, code) do nothing
       returning *`,
      [
        context.tenantId,
        values.organizationId,
        values.parentId as string,
        values.code,
        values.name,
        values.responsibleMembershipId as string,
        values.active,
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    const [row] = result.rows as CostCenterRow[]
    return row ? toCostCenter(row) : null
  }

  async updateCostCenter(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<Omit<CostCenterValues, 'organizationId' | 'code'>>
  ) {
    const row = await this.costCenters.update(
      scope,
      id,
      expectedVersion,
      columns(values, COST_CENTER_COLUMNS) as never
    )
    return toCostCenter(row)
  }

  costCenterParents(scope: TenantScope, organizationId: string) {
    return parentMap(scope, 'cost_centers', organizationId)
  }

  // --- equipas ---------------------------------------------------------------------------------

  async listTeamMembers(scope: TenantScope, unitId: string) {
    const result = await trxOf(scope).rawQuery(
      `select id, unit_id, membership_id, starts_on::text as starts_on, ends_on::text as ends_on, role_label
         from team_members where tenant_id = ? and unit_id = ? order by starts_on, id`,
      [tenantOf(scope), unitId]
    )
    return (result.rows as Record<string, string | null>[]).map(toTeamMember)
  }

  async insertTeamMember(scope: TenantScope, values: Omit<TeamMember, 'id'>) {
    const context = contextOf(scope)
    const result = await trxOf(scope).rawQuery(
      `insert into team_members
         (tenant_id, unit_id, membership_id, starts_on, ends_on, role_label,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       returning id, unit_id, membership_id, starts_on::text as starts_on, ends_on::text as ends_on, role_label`,
      [
        context.tenantId,
        values.unitId,
        values.membershipId,
        values.startsOn,
        values.endsOn as string,
        values.roleLabel as string,
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    return toTeamMember((result.rows as Record<string, string | null>[])[0])
  }

  async deleteTeamMember(scope: TenantScope, id: string) {
    const rows = await trxOf(scope)
      .from('team_members')
      .where({ tenant_id: tenantOf(scope), id })
      .delete()
      .returning('id')
    return rows.length > 0
  }

  // --- âmbitos ---------------------------------------------------------------------------------

  async listScopes(scope: TenantScope, membershipId?: string) {
    const query = trxOf(scope)
      .from('membership_scopes')
      .where('tenant_id', tenantOf(scope))
      .orderBy('created_at')
      .limit(500)
    if (membershipId) query.where('membership_id', membershipId)
    const rows = await query
    return rows.map(toScope)
  }

  async insertScope(scope: TenantScope, values: Omit<MembershipScope, 'id'>) {
    const context = contextOf(scope)
    const result = await trxOf(scope).rawQuery(
      `insert into membership_scopes
         (tenant_id, membership_id, organization_id, organization_unit_id, include_descendants,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning *`,
      [
        context.tenantId,
        values.membershipId,
        values.organizationId,
        values.organizationUnitId as string,
        values.includeDescendants,
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    const [row] = result.rows
    return row ? toScope(row) : null
  }

  async deleteScope(scope: TenantScope, id: string) {
    const rows = await trxOf(scope)
      .from('membership_scopes')
      .where({ tenant_id: tenantOf(scope), id })
      .delete()
      .returning('membership_id')
    return rows.length > 0 ? (rows[0].membership_id as string) : null
  }

  /**
   * Âmbito sem unidade = todas as unidades da organização; com unidade = essa unidade e, se
   * `include_descendants`, a sua subárvore. O resultado é a lista plana usada no `TenantContext`.
   */
  async expandUnitScope(scope: TenantScope, membershipId: string) {
    const tenantId = tenantOf(scope)
    const result = await trxOf(scope).rawQuery(
      `with recursive seeds as (
         select u.id, s.include_descendants as descend
           from membership_scopes s
           join organization_units u
             on u.tenant_id = s.tenant_id and u.organization_id = s.organization_id
            and (s.organization_unit_id is null or u.id = s.organization_unit_id)
          where s.tenant_id = ? and s.membership_id = ?
       ), tree as (
         select id, descend from seeds
         union
         select c.id, t.descend
           from tree t
           join organization_units c on c.tenant_id = ? and c.parent_id = t.id
          where t.descend
       )
       select distinct id from tree`,
      [tenantId, membershipId, tenantId]
    )
    return (result.rows as { id: string }[]).map((r) => r.id).sort()
  }
}

function toTeamMember(r: Record<string, string | null>): TeamMember {
  return {
    id: r.id as string,
    unitId: r.unit_id as string,
    membershipId: r.membership_id as string,
    startsOn: r.starts_on as string,
    endsOn: r.ends_on,
    roleLabel: r.role_label,
  }
}

function toScope(r: Record<string, unknown>): MembershipScope {
  return {
    id: r.id as string,
    membershipId: r.membership_id as string,
    organizationId: r.organization_id as string,
    organizationUnitId: r.organization_unit_id as string | null,
    includeDescendants: r.include_descendants as boolean,
  }
}
