import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import {
  crudFind,
  crudInsert,
  crudList,
  crudUpdate,
  wouldCreateCycle,
  type CrudScope,
  type CrudSpec,
  type Row,
} from '#shared/db/tenant_crud'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { assertWithinLimit } from '#modules/subscription/index'
import { audit, diff } from '#modules/audit/index'
import { normalize, type OrgKind, type Values } from '#modules/organization/domain/organization'

const common = { status: 'status', validFrom: 'valid_from', validTo: 'valid_to' }
const dates = ['valid_from', 'valid_to']
const taken = (code: string, what: string) => ({
  code,
  message: `Já existe ${what} com este código.`,
})

export const SPECS: Record<OrgKind, CrudSpec> = {
  legalEntities: {
    table: 'legal_entities',
    columns: {
      code: 'code',
      legalName: 'legal_name',
      tradeName: 'trade_name',
      taxId: 'tax_id',
      countryCode: 'country_code',
      functionalCurrency: 'functional_currency',
      ...common,
    },
    dateColumns: dates,
    searchColumns: ['code', 'legal_name', 'tax_id'],
    orderBy: 'code',
    uniqueErrors: {
      legal_entities_code_unique: taken('LEGAL_ENTITY_CODE_TAKEN', 'uma entidade legal'),
      legal_entities_tax_id_unique: {
        code: 'TAX_ID_TAKEN',
        message: 'Já existe uma entidade legal com este NIF neste país.',
      },
    },
  },
  branches: {
    table: 'branches',
    columns: {
      code: 'code',
      name: 'name',
      legalEntityId: 'legal_entity_id',
      type: 'type',
      ...common,
    },
    dateColumns: dates,
    searchColumns: ['code', 'name'],
    orderBy: 'code',
    uniqueErrors: { branches_code_unique: taken('BRANCH_CODE_TAKEN', 'uma filial') },
  },
  departments: {
    table: 'departments',
    columns: {
      code: 'code',
      name: 'name',
      legalEntityId: 'legal_entity_id',
      branchId: 'branch_id',
      parentId: 'parent_id',
      ...common,
    },
    dateColumns: dates,
    searchColumns: ['code', 'name'],
    orderBy: 'code',
    uniqueErrors: { departments_code_unique: taken('DEPARTMENT_CODE_TAKEN', 'um departamento') },
  },
  positions: {
    table: 'positions',
    columns: {
      code: 'code',
      name: 'name',
      departmentId: 'department_id',
      jobFamily: 'job_family',
      category: 'category',
      level: 'level',
      description: 'description',
      ...common,
    },
    dateColumns: dates,
    searchColumns: ['code', 'name', 'job_family'],
    orderBy: 'code',
    uniqueErrors: { positions_code_unique: taken('POSITION_CODE_TAKEN', 'um cargo') },
  },
  costCenters: {
    table: 'cost_centers',
    columns: {
      code: 'code',
      name: 'name',
      legalEntityId: 'legal_entity_id',
      parentId: 'parent_id',
      departmentId: 'department_id',
      ...common,
    },
    dateColumns: dates,
    searchColumns: ['code', 'name'],
    orderBy: 'code',
    uniqueErrors: {
      cost_centers_code_unique: taken(
        'COST_CENTER_CODE_TAKEN',
        'um centro de custo nesta entidade legal'
      ),
    },
  },
}

/** Filtros aceites por tipo (campo da API → só igualdade). */
export const FILTERS: Record<OrgKind, readonly string[]> = {
  legalEntities: ['status', 'countryCode'],
  branches: ['status', 'legalEntityId', 'type'],
  departments: ['status', 'legalEntityId', 'branchId', 'parentId'],
  positions: ['status', 'departmentId'],
  costCenters: ['status', 'legalEntityId', 'parentId', 'departmentId'],
}

const crud = (context: TenantContext, trx: CrudScope['trx']): CrudScope => ({
  trx,
  tenantId: context.tenantId,
  userId: context.userId,
})

/**
 * Referências entre entidades: tudo da mesma empresa (FKs compostas) **e** da mesma entidade legal; árvores sem ciclos.
 * As alterações de pai serializam-se por empresa e tabela (advisory lock), para que dois pedidos simultâneos não formem um
 * ciclo que nenhum deles via sozinho.
 */
const TREES: readonly OrgKind[] = ['departments', 'costCenters']

/**
 * Serializa as escritas numa árvore por empresa. Tem de ser pedido **antes** de bloquear a linha: ao gravar o novo pai, a
 * FK pede um bloqueio partilhado na linha do pai; se outro pedido a tivesse bloqueado (FOR UPDATE) e esperasse por este
 * bloqueio, haveria deadlock.
 */
async function lockTree(s: CrudScope, kind: OrgKind) {
  if (!TREES.includes(kind)) return
  await s.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
    `${s.tenantId}:${SPECS[kind].table}:tree`,
  ])
}

async function checkReferences(s: CrudScope, kind: OrgKind, id: string | null, merged: Values) {
  const issues: ErrorDetail[] = []
  const legalEntityOf = async (target: OrgKind, refId: unknown, path: string) => {
    if (refId === null || refId === undefined) return null
    const row = await crudFind(s, SPECS[target], refId as string)
    if (!row) {
      issues.push({ path, code: 'NOT_FOUND', message: 'Não existe nesta empresa.' })
      return null
    }
    return row
  }
  const sameLegalEntity = (row: Row | null, path: string) => {
    if (row && row.legalEntityId !== merged.legalEntityId) {
      issues.push({ path, code: 'OTHER_LEGAL_ENTITY', message: 'Pertence a outra entidade legal.' })
    }
  }
  if (merged.legalEntityId !== undefined) {
    const le = await crudFind(s, SPECS.legalEntities, merged.legalEntityId as string)
    if (!le)
      issues.push({
        path: 'legalEntityId',
        code: 'NOT_FOUND',
        message: 'A entidade legal não existe nesta empresa.',
      })
  }
  if (kind === 'departments') {
    sameLegalEntity(await legalEntityOf('branches', merged.branchId, 'branchId'), 'branchId')
  }
  if (kind === 'positions' && merged.departmentId) {
    await legalEntityOf('departments', merged.departmentId, 'departmentId')
  }
  if (kind === 'costCenters') {
    sameLegalEntity(
      await legalEntityOf('departments', merged.departmentId, 'departmentId'),
      'departmentId'
    )
  }
  if ((kind === 'departments' || kind === 'costCenters') && merged.parentId) {
    const table = SPECS[kind].table
    const parent = await crudFind(s, SPECS[kind], merged.parentId as string)
    if (!parent)
      issues.push({
        path: 'parentId',
        code: 'NOT_FOUND',
        message: 'O pai não existe nesta empresa.',
      })
    else {
      sameLegalEntity(parent, 'parentId')
      if (id && (await wouldCreateCycle(s, table, id, merged.parentId as string))) {
        issues.push({ path: 'parentId', code: 'CYCLE', message: 'Criaria um ciclo na hierarquia.' })
      }
    }
  }
  if (issues.length > 0) throw ApiError.validation(issues)
}

/** Tipo da entidade na auditoria e nos anexos (singular, snake_case). */
export const ENTITY_TYPES: Record<OrgKind, string> = {
  legalEntities: 'legal_entity',
  branches: 'branch',
  departments: 'department',
  positions: 'position',
  costCenters: 'cost_center',
}

/** Casos de uso da estrutura organizacional. Sem eliminação física: inactiva-se (o histórico e as referências ficam). */
export class OrganizationService {
  list(
    context: TenantContext,
    kind: OrgKind,
    filter: {
      equals: Values
      q?: string
      limit?: number
      offset?: number
      sort?: { field: string; direction: 'asc' | 'desc' }
    }
  ) {
    return runInTenant(context, ({ trx }) =>
      crudList(crud(context, trx), SPECS[kind], {
        equals: filter.equals,
        q: filter.q,
        limit: Math.min(filter.limit ?? 50, 200),
        offset: filter.offset ?? 0,
        sort: filter.sort,
      })
    )
  }

  get(context: TenantContext, kind: OrgKind, id: string) {
    return runInTenant(context, async ({ trx }) => {
      const row = await crudFind(crud(context, trx), SPECS[kind], id)
      if (!row) throw ApiError.notFound()
      return row
    })
  }

  create(context: TenantContext, kind: OrgKind, input: Values) {
    const { values, issues } = normalize(kind, input, null)
    if (issues.length > 0) throw ApiError.validation(issues)
    return runInTenant(context, async (scope) => {
      const { trx } = scope
      const s = crud(context, trx)
      await lockTree(s, kind)
      if (kind === 'legalEntities') {
        await assertWithinLimit(trx, context.tenantId, 'legal_entities.max', async () => {
          const r = await trx.rawQuery(
            'select count(*)::int as n from legal_entities where tenant_id = ?',
            [context.tenantId]
          )
          return (r.rows[0] as { n: number }).n
        })
      }
      await checkReferences(s, kind, null, values)
      const row = await crudInsert(s, SPECS[kind], values)
      await audit(scope, {
        action: `${ENTITY_TYPES[kind]}.created`,
        entityType: ENTITY_TYPES[kind],
        entityId: row.id,
        changes: diff(null, row, Object.keys(SPECS[kind].columns)),
      })
      return row
    })
  }

  update(
    context: TenantContext,
    kind: OrgKind,
    id: string,
    input: Values & { expectedVersion: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = crud(context, scope.trx)
      await lockTree(s, kind)
      const current = await crudFind(s, SPECS[kind], id, true)
      if (!current) throw ApiError.notFound()
      const { expectedVersion, ...rest } = input
      const { values, issues } = normalize(kind, rest, current)
      if (issues.length > 0) throw ApiError.validation(issues)
      await checkReferences(s, kind, id, { ...current, ...values })
      const row = await crudUpdate(s, SPECS[kind], id, expectedVersion, values)
      const changes = diff(current, row, Object.keys(SPECS[kind].columns))
      if (changes) {
        await audit(scope, {
          action: `${ENTITY_TYPES[kind]}.updated`,
          entityType: ENTITY_TYPES[kind],
          entityId: id,
          changes,
        })
      }
      return row
    })
  }
}

const KIND_BY_ENTITY = new Map(
  (Object.entries(ENTITY_TYPES) as [OrgKind, string][]).map(([kind, type]) => [type, kind])
)

/** O registo organizacional existe nesta empresa? (`entityType` no singular, ex.: `legal_entity`). */
export async function organizationRecordExists(scope: TenantScope, entityType: string, id: string) {
  const kind = KIND_BY_ENTITY.get(entityType)
  if (!kind) return false
  const s = crud(scope.context, scope.trx)
  return (await crudFind(s, SPECS[kind], id)) !== null
}

/** Registos activos de cada tipo (para o painel). */
export async function organizationCounts(scope: TenantScope) {
  const result = await scope.trx.rawQuery(
    `select 'legalEntities' as kind, count(*)::int as n from legal_entities where tenant_id = ? and status = 'ACTIVE'
     union all select 'branches', count(*)::int from branches where tenant_id = ? and status = 'ACTIVE'
     union all select 'departments', count(*)::int from departments where tenant_id = ? and status = 'ACTIVE'
     union all select 'positions', count(*)::int from positions where tenant_id = ? and status = 'ACTIVE'
     union all select 'costCenters', count(*)::int from cost_centers where tenant_id = ? and status = 'ACTIVE'`,
    Array(5).fill(scope.context.tenantId)
  )
  return Object.fromEntries(
    (result.rows as { kind: string; n: number }[]).map((r) => [r.kind, r.n])
  ) as Record<OrgKind, number>
}

/** Pesquisa por código/nome em todos os tipos (até `limit` por tipo). */
export async function searchOrganization(scope: TenantScope, q: string, limit: number) {
  const s = crud(scope.context, scope.trx)
  const out: { kind: OrgKind; id: string; title: string; subtitle: string | null }[] = []
  for (const kind of Object.keys(SPECS) as OrgKind[]) {
    const page = await crudList(s, SPECS[kind], { q, limit, offset: 0 })
    for (const r of page.items)
      out.push({
        kind,
        id: r.id,
        title: `${r.code as string} — ${(r.name ?? r.legalName) as string}`,
        subtitle: (r.status as string) === 'INACTIVE' ? 'Inactivo' : null,
      })
  }
  return out
}
