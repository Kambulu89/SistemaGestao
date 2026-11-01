import { ApiError } from '#core/http/api_error'
import type { TenantScope } from '#core/tenancy/application/tenant_unit_of_work'
import { LucidTenantScope } from '#core/tenancy/infrastructure/lucid_tenant_database'

/** Colunas base de toda a entidade de tenant (spec §1.1). */
export interface TenantRow {
  id: string
  tenant_id: string
  created_at: Date
  updated_at: Date
  created_by_membership_id: string | null
  updated_by_membership_id: string | null
  version: number
}

/** Colunas que o chamador nunca fornece: vêm do contexto ou são geridas pelo repositório. */
export const RESERVED_COLUMNS = [
  'id',
  'tenant_id',
  'created_at',
  'updated_at',
  'created_by_membership_id',
  'updated_by_membership_id',
  'version',
] as const satisfies readonly (keyof TenantRow)[]

export type WritableValues<Row extends TenantRow> = Omit<Row, (typeof RESERVED_COLUMNS)[number]>

/** Erro de programação (nunca do cliente): tentativa de definir uma coluna reservada. */
export class ReservedColumnError extends Error {
  constructor(column: string) {
    super(`A coluna "${column}" não pode ser definida pelo chamador.`)
    this.name = 'ReservedColumnError'
  }
}

export interface ListOptions {
  /** 1..100 */
  limit?: number
  offset?: number
}

function assertNoReserved(values: Record<string, unknown>) {
  for (const column of RESERVED_COLUMNS) {
    if (column in values) throw new ReservedColumnError(column)
  }
}

function lucidScope(scope: TenantScope): LucidTenantScope {
  if (!(scope instanceof LucidTenantScope)) {
    throw new Error('Âmbito de tenant inválido: use LucidTenantDatabase.run().')
  }
  return scope
}

/**
 * Base dos repositórios de entidades de tenant. Todas as consultas levam **dois** controlos
 * independentes: o filtro explícito `tenant_id = contexto` e a RLS da base de dados. O `tenant_id`
 * é sempre o do contexto; não existe forma de o passar como valor. Um registo de outro tenant é
 * indistinguível de um que não existe (404).
 */
export abstract class TenantRepository<Row extends TenantRow> {
  /** Nome da tabela (pode incluir o esquema: `schema.tabela`). */
  protected abstract readonly table: string

  async findById(scope: TenantScope, id: string): Promise<Row | null> {
    const { trx, context } = lucidScope(scope)
    const row = await trx.from(this.table).where({ tenant_id: context.tenantId, id }).first()
    return (row as Row | undefined) ?? null
  }

  async getById(scope: TenantScope, id: string): Promise<Row> {
    const row = await this.findById(scope, id)
    if (!row) throw ApiError.notFound()
    return row
  }

  async list(scope: TenantScope, options: ListOptions = {}): Promise<Row[]> {
    const { trx, context } = lucidScope(scope)
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
    const offset = Math.max(options.offset ?? 0, 0)
    const rows = await trx
      .from(this.table)
      .where({ tenant_id: context.tenantId })
      .orderBy([{ column: 'created_at' }, { column: 'id' }])
      .limit(limit)
      .offset(offset)
    return rows as Row[]
  }

  async insert(scope: TenantScope, values: WritableValues<Row>): Promise<Row> {
    const { trx, context } = lucidScope(scope)
    assertNoReserved(values as Record<string, unknown>)
    const [row] = await trx
      .table(this.table)
      .insert({
        ...values,
        tenant_id: context.tenantId,
        created_by_membership_id: context.membershipId,
        updated_by_membership_id: context.membershipId,
      })
      .returning('*')
    return row as Row
  }

  /**
   * Actualiza com controlo de concorrência optimista. Se a versão já não for `expectedVersion`
   * responde 409 `VERSION_CONFLICT` (com a versão actual); se o registo não existe neste tenant, 404.
   */
  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<WritableValues<Row>>
  ): Promise<Row> {
    const { trx, context } = lucidScope(scope)
    assertNoReserved(values as Record<string, unknown>)

    const [row] = await trx
      .from(this.table)
      .where({ tenant_id: context.tenantId, id, version: expectedVersion })
      .update({
        ...values,
        updated_at: new Date(),
        updated_by_membership_id: context.membershipId,
        // O filtro `version = expectedVersion` garante que só uma actualização concorrente prevalece.
        version: expectedVersion + 1,
      })
      .returning('*')
    if (row) return row as Row

    const current = await this.findById(scope, id)
    if (!current) throw ApiError.notFound()
    throw ApiError.versionConflict(current.version)
  }
}
