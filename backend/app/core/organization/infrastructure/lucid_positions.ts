import {
  LucidTenantScope,
  TenantRepository,
  type TenantRow,
  type TenantScope,
} from '#core/tenancy/index'
import type { Position, PositionStatus, PositionValues } from '#core/organization/domain/position'
import type {
  PositionFilter,
  PositionStore,
} from '#core/organization/application/position_use_cases'

interface PositionRow extends TenantRow {
  code: string
  name: string
  description: string | null
  job_family: string | null
  category: string | null
  hierarchy_level: number | null
  department_id: string | null
  parent_id: string | null
  responsibilities: string | null
  competencies: string[]
  academic_requirements: string | null
  recommended_experience: string | null
  status: PositionStatus
}

class Positions extends TenantRepository<PositionRow> {
  protected readonly table = 'positions'
}

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const contextOf = (scope: TenantScope) => (scope as LucidTenantScope).context

const toPosition = (row: PositionRow): Position => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  jobFamily: row.job_family,
  category: row.category,
  hierarchyLevel: row.hierarchy_level,
  departmentId: row.department_id,
  parentId: row.parent_id,
  responsibilities: row.responsibilities,
  competencies: row.competencies ?? [],
  academicRequirements: row.academic_requirements,
  recommendedExperience: row.recommended_experience,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const COLUMNS: Record<keyof Omit<PositionValues, 'code'>, string> = {
  name: 'name',
  description: 'description',
  jobFamily: 'job_family',
  category: 'category',
  hierarchyLevel: 'hierarchy_level',
  departmentId: 'department_id',
  parentId: 'parent_id',
  responsibilities: 'responsibilities',
  competencies: 'competencies',
  academicRequirements: 'academic_requirements',
  recommendedExperience: 'recommended_experience',
  status: 'status',
}

export class LucidPositionStore implements PositionStore {
  private readonly positions = new Positions()

  async list(scope: TenantScope, filter: PositionFilter) {
    const query = trxOf(scope)
      .from('positions')
      .where('tenant_id', contextOf(scope).tenantId)
      .orderBy('code')
      .limit(filter.limit)
      .offset(filter.offset)
    if (filter.departmentId) query.where('department_id', filter.departmentId)
    if (filter.status) query.where('status', filter.status)
    if (filter.q) {
      const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      query.where((q) => q.whereILike('code', like).orWhereILike('name', like))
    }
    return ((await query) as PositionRow[]).map(toPosition)
  }

  async find(scope: TenantScope, id: string) {
    const row = await this.positions.findById(scope, id)
    return row ? toPosition(row) : null
  }

  async insert(scope: TenantScope, values: PositionValues) {
    const context = contextOf(scope)
    const result = await trxOf(scope).rawQuery(
      `insert into positions
         (tenant_id, code, name, description, job_family, category, hierarchy_level, department_id, parent_id,
          responsibilities, competencies, academic_requirements, recommended_experience, status,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, code) do nothing
       returning *`,
      [
        context.tenantId,
        values.code,
        values.name,
        values.description as string,
        values.jobFamily as string,
        values.category as string,
        values.hierarchyLevel as number,
        values.departmentId as string,
        values.parentId as string,
        values.responsibilities as string,
        values.competencies as unknown as string,
        values.academicRequirements as string,
        values.recommendedExperience as string,
        values.status,
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    const [row] = result.rows as PositionRow[]
    return row ? toPosition(row) : null
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<Omit<PositionValues, 'code'>>
  ) {
    const changes: Record<string, unknown> = {}
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (key in values) changes[column] = (values as Record<string, unknown>)[key]
    }
    return toPosition(await this.positions.update(scope, id, expectedVersion, changes as never))
  }

  async parents(scope: TenantScope) {
    const rows = (await trxOf(scope)
      .from('positions')
      .where('tenant_id', contextOf(scope).tenantId)
      .select('id', 'parent_id')) as { id: string; parent_id: string | null }[]
    return new Map(rows.map((r) => [r.id, r.parent_id]))
  }

  async activeChildren(scope: TenantScope, id: string) {
    const row = (await trxOf(scope)
      .from('positions')
      .where({ tenant_id: contextOf(scope).tenantId, parent_id: id, status: 'ACTIVE' })
      .count('* as n')
      .first()) as { n: string | number } | undefined
    return Number(row?.n ?? 0)
  }
}
