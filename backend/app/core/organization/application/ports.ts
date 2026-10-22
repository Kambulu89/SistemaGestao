import type { TenantScope } from '#core/tenancy/index'
import type {
  CostCenter,
  MembershipScope,
  Organization,
  OrganizationUnit,
  TeamMember,
} from '#core/organization/domain/organization'

export type OrganizationValues = Omit<Organization, 'id' | 'version'>
export type UnitValues = Omit<OrganizationUnit, 'id' | 'version'>
export type CostCenterValues = Omit<CostCenter, 'id' | 'version'>

/** Dados de organização do tenant. Todas as operações correm no âmbito (transacção + RLS) do contexto. */
export interface OrganizationStore {
  /** Serializa as alterações à estrutura (árvores) do tenant até ao fim da transacção. */
  lockStructure(scope: TenantScope): Promise<void>

  listOrganizations(scope: TenantScope): Promise<Organization[]>
  findOrganization(scope: TenantScope, id: string): Promise<Organization | null>
  /** `null` se o código já existir. */
  insertOrganization(scope: TenantScope, values: OrganizationValues): Promise<Organization | null>
  updateOrganization(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<OrganizationValues>
  ): Promise<Organization>

  listUnits(scope: TenantScope, organizationId?: string): Promise<OrganizationUnit[]>
  findUnit(scope: TenantScope, id: string): Promise<OrganizationUnit | null>
  /** `null` se o código já existir na organização. */
  insertUnit(scope: TenantScope, values: UnitValues): Promise<OrganizationUnit | null>
  updateUnit(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<Omit<UnitValues, 'organizationId' | 'code'>>
  ): Promise<OrganizationUnit>
  unitParents(scope: TenantScope, organizationId: string): Promise<Map<string, string | null>>

  listCostCenters(scope: TenantScope, organizationId?: string): Promise<CostCenter[]>
  findCostCenter(scope: TenantScope, id: string): Promise<CostCenter | null>
  insertCostCenter(scope: TenantScope, values: CostCenterValues): Promise<CostCenter | null>
  updateCostCenter(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<Omit<CostCenterValues, 'organizationId' | 'code'>>
  ): Promise<CostCenter>
  costCenterParents(scope: TenantScope, organizationId: string): Promise<Map<string, string | null>>

  listTeamMembers(scope: TenantScope, unitId: string): Promise<TeamMember[]>
  insertTeamMember(scope: TenantScope, values: Omit<TeamMember, 'id'>): Promise<TeamMember>
  /** `false` se não existir neste tenant. */
  deleteTeamMember(scope: TenantScope, id: string): Promise<boolean>

  listScopes(scope: TenantScope, membershipId?: string): Promise<MembershipScope[]>
  /** `null` se o mesmo âmbito já existir. */
  insertScope(
    scope: TenantScope,
    values: Omit<MembershipScope, 'id'>
  ): Promise<MembershipScope | null>
  /** Devolve a membership afectada, ou `null` se não existir. */
  deleteScope(scope: TenantScope, id: string): Promise<string | null>
  /** Unidades a que a membership tem acesso (âmbitos expandidos com descendentes), sem duplicados. */
  expandUnitScope(scope: TenantScope, membershipId: string): Promise<string[]>
}
