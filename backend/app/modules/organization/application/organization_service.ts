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
import { runInTenant, type TenantContext } from '#modules/tenancy/index'
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

/** Casos de uso da estrutura organizacional. Sem eliminação física: inactiva-se (o histórico e as referências ficam). */
export class OrganizationService {
  list(
    context: TenantContext,
    kind: OrgKind,
    filter: { equals: Values; q?: string; limit?: number; offset?: number }
  ) {
    return runInTenant(context, ({ trx }) =>
      crudList(crud(context, trx), SPECS[kind], {
        equals: filter.equals,
        q: filter.q,
        limit: Math.min(filter.limit ?? 50, 200),
        offset: filter.offset ?? 0,
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
    return runInTenant(context, async ({ trx }) => {
      const s = crud(context, trx)
      await lockTree(s, kind)
      await checkReferences(s, kind, null, values)
      return crudInsert(s, SPECS[kind], values)
    })
  }

  update(
    context: TenantContext,
    kind: OrgKind,
    id: string,
    input: Values & { expectedVersion: number }
  ) {
    return runInTenant(context, async ({ trx }) => {
      const s = crud(context, trx)
      await lockTree(s, kind)
      const current = await crudFind(s, SPECS[kind], id, true)
      if (!current) throw ApiError.notFound()
      const { expectedVersion, ...rest } = input
      const { values, issues } = normalize(kind, rest, current)
      if (issues.length > 0) throw ApiError.validation(issues)
      await checkReferences(s, kind, id, { ...current, ...values })
      return crudUpdate(s, SPECS[kind], id, expectedVersion, values)
    })
  }
}
