import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { ApiError } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'

/**
 * Repositório genérico para tabelas de tenant (as criadas por `createTenantTable`). Corre sempre na transacção de
 * `runInTenant` (RLS activa) e repete o filtro por `tenant_id`. Só aceita os nomes de colunas declarados na
 * especificação: nunca interpola nomes vindos do pedido.
 */
export interface CrudSpec {
  table: string
  /** Campo da API (camelCase) → coluna (snake_case). Não inclui id/version/datas de auditoria. */
  columns: Record<string, string>
  /** Colunas `date`, devolvidas como `AAAA-MM-DD`. */
  dateColumns?: readonly string[]
  /** Colunas pesquisadas por `q` (ILIKE). */
  searchColumns: readonly string[]
  orderBy: string
  /** Restrição única violada → erro 409 com código estável. */
  uniqueErrors: Record<string, { code: string; message: string }>
}

export interface CrudScope {
  trx: TransactionClientContract
  tenantId: string
  userId: string
}

export type Row = Record<string, unknown> & { id: string; version: number }

function selectList(spec: CrudSpec) {
  const dates = new Set(spec.dateColumns ?? [])
  const fields = Object.entries(spec.columns).map(([key, column]) =>
    dates.has(column) ? `${column}::text as "${key}"` : `${column} as "${key}"`
  )
  return [
    'id',
    'version',
    'created_at as "createdAt"',
    'updated_at as "updatedAt"',
    ...fields,
  ].join(', ')
}

const columnFor = (spec: CrudSpec, key: string) => {
  const column = spec.columns[key]
  if (!column) throw new Error(`Campo não declarado em ${spec.table}: ${key}`)
  return column
}

export async function crudList(
  s: CrudScope,
  spec: CrudSpec,
  filter: { equals?: Record<string, unknown>; q?: string; limit: number; offset: number }
): Promise<{ items: Row[]; total: number }> {
  const where = ['tenant_id = ?']
  const params: unknown[] = [s.tenantId]
  for (const [key, value] of Object.entries(filter.equals ?? {})) {
    if (value === undefined) continue
    if (value === null) where.push(`${columnFor(spec, key)} is null`)
    else {
      where.push(`${columnFor(spec, key)} = ?`)
      params.push(value)
    }
  }
  if (filter.q && spec.searchColumns.length > 0) {
    const like = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(`(${spec.searchColumns.map((c) => `lower(${c}) like ?`).join(' or ')})`)
    params.push(...spec.searchColumns.map(() => like))
  }
  const clause = where.join(' and ')
  const rows = await s.trx.rawQuery(
    `select ${selectList(spec)} from ${spec.table} where ${clause} order by ${spec.orderBy} limit ? offset ?`,
    [...params, filter.limit, filter.offset] as never[]
  )
  const count = await s.trx.rawQuery(
    `select count(*)::int as total from ${spec.table} where ${clause}`,
    params as never[]
  )
  return { items: rows.rows as Row[], total: (count.rows[0] as { total: number }).total }
}

export async function crudFind(
  s: CrudScope,
  spec: CrudSpec,
  id: string,
  lock = false
): Promise<Row | null> {
  const result = await s.trx.rawQuery(
    `select ${selectList(spec)} from ${spec.table} where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [s.tenantId, id]
  )
  return (result.rows[0] as Row | undefined) ?? null
}

async function guarded<T>(s: CrudScope, spec: CrudSpec, fn: () => Promise<T>): Promise<T> {
  await s.trx.rawQuery('savepoint crud_write')
  try {
    const result = await fn()
    await s.trx.rawQuery('release savepoint crud_write')
    return result
  } catch (error) {
    const constraint = constraintOf(error)
    const mapped = constraint ? spec.uniqueErrors[constraint] : undefined
    if (mapped) {
      await s.trx.rawQuery('rollback to savepoint crud_write')
      throw ApiError.conflict(mapped.code, mapped.message)
    }
    throw error
  }
}

export async function crudInsert(
  s: CrudScope,
  spec: CrudSpec,
  values: Record<string, unknown>
): Promise<Row> {
  const keys = Object.keys(values)
  const id = await guarded(s, spec, async () => {
    const result = await s.trx.rawQuery(
      `insert into ${spec.table} (tenant_id, created_by, updated_by, ${keys.map((k) => columnFor(spec, k)).join(', ')})
       values (?, ?, ?, ${keys.map(() => '?').join(', ')}) returning id`,
      [s.tenantId, s.userId, s.userId, ...keys.map((k) => values[k])] as never[]
    )
    return (result.rows[0] as { id: string }).id
  })
  return (await crudFind(s, spec, id))!
}

export async function crudUpdate(
  s: CrudScope,
  spec: CrudSpec,
  id: string,
  expectedVersion: number,
  values: Record<string, unknown>
): Promise<Row> {
  const keys = Object.keys(values)
  const updated = await guarded(s, spec, async () => {
    const result = await s.trx.rawQuery(
      `update ${spec.table} set ${keys.map((k) => `${columnFor(spec, k)} = ?`).join(', ')},
              updated_by = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [...keys.map((k) => values[k]), s.userId, s.tenantId, id, expectedVersion] as never[]
    )
    return result.rows.length > 0
  })
  if (!updated) {
    const current = await crudFind(s, spec, id)
    if (!current) throw ApiError.notFound()
    throw ApiError.versionConflict(current.version)
  }
  return (await crudFind(s, spec, id))!
}

/** True se `candidateParentId` é o próprio registo ou um descendente dele (criaria um ciclo). */
export async function wouldCreateCycle(
  s: CrudScope,
  table: string,
  id: string,
  candidateParentId: string
) {
  if (id === candidateParentId) return true
  const result = await s.trx.rawQuery(
    `with recursive descendants as (
       select id from ${table} where tenant_id = ? and parent_id = ?
       union select t.id from ${table} t join descendants d on t.parent_id = d.id where t.tenant_id = ?)
     select 1 from descendants where id = ? limit 1`,
    [s.tenantId, id, s.tenantId, candidateParentId]
  )
  return result.rows.length > 0
}
