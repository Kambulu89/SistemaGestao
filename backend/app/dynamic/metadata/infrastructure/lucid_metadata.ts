import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type {
  FieldOption,
  FieldPresentation,
  FieldSpec,
  FieldType,
} from '#dynamic/metadata/domain/field_types'
import type { EntityPresentation } from '#dynamic/metadata/domain/presentation'
import type {
  DynamicRecord,
  EntityDefinition,
  EntityStatus,
  EntityStore,
  OwnershipMode,
  RecordFilter,
  RecordStore,
  RecordWrite,
  ReferenceLookup,
  SchemaVersion,
  VersionStore,
  VersionSummary,
} from '#dynamic/metadata/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const ctxOf = (scope: TenantScope) => (scope as LucidTenantScope).context
const tenantOf = (scope: TenantScope) => ctxOf(scope).tenantId
const actorOf = (scope: TenantScope) => ctxOf(scope).membershipId as never

const json = (value: unknown) => JSON.stringify(value)
const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(', ')

/**
 * `UPDATE` com controlo de versão: 404 se a linha não existe neste tenant, 409 `VERSION_CONFLICT` se mudou.
 * Sem colunas, apenas avança a versão (usado para serializar edições concorrentes do rascunho).
 */
async function versionedUpdate<Row>(
  scope: TenantScope,
  table: string,
  returning: string,
  id: string,
  expectedVersion: number,
  columns: Record<string, unknown>
): Promise<Row> {
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined)
  const sets = entries.map(([c]) => `"${c}" = ?`).join(', ')
  const result = await trxOf(scope).rawQuery(
    `update ${table}
        set ${sets}${sets ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
      where tenant_id = ? and id = ? and version = ?
      returning ${returning}`,
    [...entries.map(([, v]) => v as never), actorOf(scope), tenantOf(scope), id, expectedVersion]
  )
  const [row] = result.rows as Row[]
  if (row) return row
  const current = await trxOf(scope).rawQuery(
    `select version from ${table} where tenant_id = ? and id = ?`,
    [tenantOf(scope), id]
  )
  const [existing] = current.rows as { version: number }[]
  if (!existing) throw ApiError.notFound()
  throw ApiError.versionConflict(existing.version)
}

// --- entidades --------------------------------------------------------------------------------

interface EntityRow {
  id: string
  code: string
  name: string
  description: string | null
  kind: 'DYNAMIC'
  status: EntityStatus
  published_version: number | null
  ownership_mode: OwnershipMode
  presentation: EntityPresentation
  version: number
  created_at: Date
  updated_at: Date
}

const ENTITY_COLUMNS = `id, code, name, description, kind, status, published_version, ownership_mode,
  presentation, version, created_at, updated_at`

const toEntity = (r: EntityRow): EntityDefinition => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  kind: r.kind,
  status: r.status,
  publishedVersion: r.published_version,
  ownershipMode: r.ownership_mode,
  presentation: r.presentation,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidEntityStore implements EntityStore {
  async lock(scope: TenantScope, entityId: string) {
    await trxOf(scope).rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
      `entity:${tenantOf(scope)}:${entityId}`,
    ])
  }

  async list(scope: TenantScope) {
    const result = await trxOf(scope).rawQuery(
      `select ${ENTITY_COLUMNS} from entity_definitions where tenant_id = ? order by code`,
      [tenantOf(scope)]
    )
    return (result.rows as EntityRow[]).map(toEntity)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${ENTITY_COLUMNS} from entity_definitions where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as EntityRow[]
    return row ? toEntity(row) : null
  }

  async findByCode(scope: TenantScope, code: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${ENTITY_COLUMNS} from entity_definitions where tenant_id = ? and code = ?`,
      [tenantOf(scope), code]
    )
    const [row] = result.rows as EntityRow[]
    return row ? toEntity(row) : null
  }

  async insert(
    scope: TenantScope,
    v: {
      code: string
      name: string
      description: string | null
      ownershipMode: OwnershipMode
      presentation: EntityPresentation
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into entity_definitions
         (tenant_id, code, name, description, ownership_mode, presentation,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?)
       on conflict (tenant_id, code) do nothing
       returning ${ENTITY_COLUMNS}`,
      [
        tenantOf(scope),
        v.code,
        v.name,
        v.description as never,
        v.ownershipMode,
        json(v.presentation),
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [row] = result.rows as EntityRow[]
    return row ? toEntity(row) : null
  }

  async delete(scope: TenantScope, id: string) {
    try {
      await trxOf(scope).rawQuery('delete from entity_definitions where tenant_id = ? and id = ?', [
        tenantOf(scope),
        id,
      ])
    } catch (error) {
      // 23503: outra entidade tem um campo de referência para esta.
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.conflict('ENTITY_IN_USE', 'Outra entidade refere esta entidade.')
      }
      throw error
    }
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: {
      name?: string
      description?: string | null
      ownershipMode?: OwnershipMode
      presentation?: EntityPresentation
      status?: EntityStatus
      publishedVersion?: number
    }
  ) {
    return toEntity(
      await versionedUpdate<EntityRow>(
        scope,
        'entity_definitions',
        ENTITY_COLUMNS,
        id,
        expectedVersion,
        {
          name: patch.name,
          description: patch.description,
          ownership_mode: patch.ownershipMode,
          presentation: patch.presentation === undefined ? undefined : json(patch.presentation),
          status: patch.status,
          published_version: patch.publishedVersion,
        }
      )
    )
  }
}

// --- versões e campos -------------------------------------------------------------------------

interface VersionRow {
  id: string
  entity_definition_id: string
  revision: number
  published_at: Date | null
}

interface FieldRow {
  code: string
  label: string
  field_type: FieldType
  required: boolean
  default_value: unknown
  validation: Record<string, unknown>
  options: FieldOption[]
  position: number
  reference_entity_id: string | null
  sensitive: boolean
  read_only: boolean
  archived: boolean
  presentation: FieldPresentation
}

const VERSION_COLUMNS = 'id, entity_definition_id, revision, published_at'

const toField = (r: FieldRow): FieldSpec => ({
  code: r.code,
  label: r.label,
  type: r.field_type,
  required: r.required,
  defaultValue: r.default_value,
  validation: r.validation,
  options: r.options,
  position: r.position,
  referenceEntityId: r.reference_entity_id,
  sensitive: r.sensitive,
  readOnly: r.read_only,
  archived: r.archived,
  presentation: r.presentation,
})

export class LucidVersionStore implements VersionStore {
  async list(scope: TenantScope, entityId: string): Promise<VersionSummary[]> {
    const result = await trxOf(scope).rawQuery(
      `select id, revision, published_at from entity_schema_versions
        where tenant_id = ? and entity_definition_id = ? order by revision`,
      [tenantOf(scope), entityId]
    )
    return (result.rows as VersionRow[]).map((r) => ({
      id: r.id,
      revision: r.revision,
      publishedAt: r.published_at,
    }))
  }

  findDraft(scope: TenantScope, entityId: string) {
    return this.one(scope, 'entity_definition_id = ? and published_at is null', [entityId])
  }

  findByRevision(scope: TenantScope, entityId: string, revision: number) {
    return this.one(scope, 'entity_definition_id = ? and revision = ?', [entityId, revision])
  }

  findById(scope: TenantScope, id: string) {
    return this.one(scope, 'id = ?', [id])
  }

  async insertDraft(scope: TenantScope, entityId: string, fields: FieldSpec[]) {
    const result = await trxOf(scope).rawQuery(
      `insert into entity_schema_versions
         (tenant_id, entity_definition_id, revision, created_by_membership_id, updated_by_membership_id)
       select ?, ?, coalesce(max(revision), 0) + 1, ?, ?
         from entity_schema_versions where tenant_id = ? and entity_definition_id = ?
       on conflict (tenant_id, entity_definition_id) where published_at is null do nothing
       returning ${VERSION_COLUMNS}`,
      [tenantOf(scope), entityId, actorOf(scope), actorOf(scope), tenantOf(scope), entityId]
    )
    const [row] = result.rows as VersionRow[]
    if (!row) return null
    await this.insertFields(scope, row.id, fields)
    return {
      id: row.id,
      entityDefinitionId: row.entity_definition_id,
      revision: row.revision,
      publishedAt: null,
      fields,
    }
  }

  async replaceFields(scope: TenantScope, versionId: string, fields: FieldSpec[]) {
    await trxOf(scope).rawQuery(
      'delete from field_definitions where tenant_id = ? and entity_schema_version_id = ?',
      [tenantOf(scope), versionId]
    )
    await this.insertFields(scope, versionId, fields)
  }

  async deleteDraft(scope: TenantScope, versionId: string) {
    await this.replaceFields(scope, versionId, [])
    await trxOf(scope).rawQuery(
      'delete from entity_schema_versions where tenant_id = ? and id = ? and published_at is null',
      [tenantOf(scope), versionId]
    )
  }

  async publish(scope: TenantScope, versionId: string, fields: FieldSpec[]) {
    await this.replaceFields(scope, versionId, fields)
    await trxOf(scope).rawQuery(
      `update entity_schema_versions
          set published_at = now(), published_by_membership_id = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and published_at is null`,
      [actorOf(scope), actorOf(scope), tenantOf(scope), versionId]
    )
  }

  private async one(
    scope: TenantScope,
    where: string,
    params: unknown[]
  ): Promise<SchemaVersion | null> {
    const result = await trxOf(scope).rawQuery(
      `select ${VERSION_COLUMNS} from entity_schema_versions where tenant_id = ? and ${where}`,
      [tenantOf(scope), ...(params as never[])]
    )
    const [row] = result.rows as VersionRow[]
    if (!row) return null
    const fields = await trxOf(scope).rawQuery(
      `select code, label, field_type, required, default_value, validation, options, position,
              reference_entity_id, sensitive, read_only, archived, presentation
         from field_definitions where tenant_id = ? and entity_schema_version_id = ? order by position`,
      [tenantOf(scope), row.id]
    )
    return {
      id: row.id,
      entityDefinitionId: row.entity_definition_id,
      revision: row.revision,
      publishedAt: row.published_at,
      fields: (fields.rows as FieldRow[]).map(toField),
    }
  }

  private async insertFields(scope: TenantScope, versionId: string, fields: FieldSpec[]) {
    for (const f of fields) {
      await trxOf(scope).rawQuery(
        `insert into field_definitions
           (tenant_id, entity_schema_version_id, code, label, field_type, required, default_value,
            validation, options, position, reference_entity_id, sensitive, read_only, archived, presentation,
            created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`,
        [
          tenantOf(scope),
          versionId,
          f.code,
          f.label,
          f.type,
          f.required,
          (f.defaultValue === null ? null : json(f.defaultValue)) as never,
          json(f.validation),
          json(f.options),
          f.position,
          f.referenceEntityId as never,
          f.sensitive,
          f.readOnly,
          f.archived,
          json(f.presentation),
          actorOf(scope),
          actorOf(scope),
        ]
      )
    }
  }
}

// --- registos ---------------------------------------------------------------------------------

interface RecordRow {
  id: string
  entity_definition_id: string
  schema_version_id: string
  owner_membership_id: string | null
  organization_unit_id: string | null
  data: Record<string, unknown>
  sensitive_data: Record<string, unknown>
  archived_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
  created_by_membership_id: string | null
  updated_by_membership_id: string | null
}

const RECORD_COLUMNS = `id, entity_definition_id, schema_version_id, owner_membership_id, organization_unit_id,
  data, sensitive_data, archived_at, version, created_at, updated_at,
  created_by_membership_id, updated_by_membership_id`

const toRecord = (r: RecordRow): DynamicRecord => ({
  id: r.id,
  entityDefinitionId: r.entity_definition_id,
  schemaVersionId: r.schema_version_id,
  ownerMembershipId: r.owner_membership_id,
  organizationUnitId: r.organization_unit_id,
  data: r.data,
  sensitiveData: r.sensitive_data,
  archivedAt: r.archived_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  createdByMembershipId: r.created_by_membership_id,
  updatedByMembershipId: r.updated_by_membership_id,
})

/** Comparação de igualdade por tipo, sobre `data ->> código` (o valor chega já normalizado). */
const FILTER_EXPRESSION: Record<string, string> = {
  TEXT: 'lower(data ->> ?) = ?',
  EMAIL: 'lower(data ->> ?) = ?',
  PHONE: 'lower(data ->> ?) = ?',
  URL: 'lower(data ->> ?) = lower(?)',
  NUMBER: '(data ->> ?)::bigint = ?',
  DECIMAL: '(data ->> ?)::numeric = ?::numeric',
  BOOLEAN: '(data ->> ?)::boolean = ?',
}

/** Ordenação por tipo (números e booleanos pelo valor, texto sem distinção de maiúsculas); desempate por id. */
function orderBy(sort: RecordFilter['sort']): { sql: string; params: string[] } {
  if (!sort) return { sql: 'created_at desc, id', params: [] }
  const direction = sort.direction === 'desc' ? 'desc' : 'asc'
  if (sort.kind === 'SYSTEM') return { sql: `${sort.column} ${direction}, id`, params: [] }
  const expression: Record<string, string> = {
    TEXT: 'lower(data ->> ?)',
    EMAIL: 'lower(data ->> ?)',
    PHONE: 'lower(data ->> ?)',
    URL: 'lower(data ->> ?)',
    NUMBER: '(data ->> ?)::bigint',
    DECIMAL: '(data ->> ?)::numeric',
    BOOLEAN: '(data ->> ?)::boolean',
  }
  return {
    sql: `${expression[sort.field.type] ?? 'data ->> ?'} ${direction} nulls last, id`,
    params: [sort.field.code],
  }
}

export class LucidRecordStore implements RecordStore {
  async insert(
    scope: TenantScope,
    entityId: string,
    v: RecordWrite & { ownerMembershipId: string | null; organizationUnitId: string | null }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into dynamic_records
         (tenant_id, entity_definition_id, schema_version_id, owner_membership_id, organization_unit_id,
          data, sensitive_data, search_text, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)
       returning ${RECORD_COLUMNS}`,
      [
        tenantOf(scope),
        entityId,
        v.schemaVersionId,
        v.ownerMembershipId as never,
        v.organizationUnitId as never,
        json(v.data),
        json(v.sensitiveData),
        v.searchText,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toRecord((result.rows as RecordRow[])[0])
  }

  async find(scope: TenantScope, entityId: string, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${RECORD_COLUMNS} from dynamic_records
        where tenant_id = ? and entity_definition_id = ? and id = ?`,
      [tenantOf(scope), entityId, id]
    )
    const [row] = result.rows as RecordRow[]
    return row ? toRecord(row) : null
  }

  async list(scope: TenantScope, entityId: string, f: RecordFilter) {
    const where = ['tenant_id = ?', 'entity_definition_id = ?']
    const params: unknown[] = [tenantOf(scope), entityId]
    where.push(f.archived ? 'archived_at is not null' : 'archived_at is null')
    if (f.q) {
      where.push("search_text like ? escape '\\'")
      params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`)
    }
    if (f.ownerMembershipId) {
      where.push('owner_membership_id = ?')
      params.push(f.ownerMembershipId)
    }
    if (f.unitIds) {
      if (f.unitIds.length === 0) return { rows: [], total: 0 }
      where.push(`organization_unit_id in (${placeholders(f.unitIds)})`)
      params.push(...f.unitIds)
    }
    // O código do campo nunca entra no SQL como texto: vai como parâmetro, já validado contra a versão.
    for (const { field, value } of f.filters) {
      where.push(`${FILTER_EXPRESSION[field.type] ?? FILTER_EXPRESSION.TEXT}`)
      params.push(field.code, value)
    }
    const order = orderBy(f.sort)
    const base = where.join(' and ')
    const result = await trxOf(scope).rawQuery(
      `select ${RECORD_COLUMNS} from dynamic_records where ${base}
        order by ${order.sql} limit ? offset ?`,
      [...(params as never[]), ...(order.params as never[]), f.limit, f.offset]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from dynamic_records where ${base}`,
      params as never[]
    )
    return {
      rows: (result.rows as RecordRow[]).map(toRecord),
      total: (count.rows as { total: number }[])[0].total,
    }
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: RecordWrite) {
    return toRecord(
      await versionedUpdate<RecordRow>(
        scope,
        'dynamic_records',
        RECORD_COLUMNS,
        id,
        expectedVersion,
        {
          schema_version_id: v.schemaVersionId,
          data: json(v.data),
          sensitive_data: json(v.sensitiveData),
          search_text: v.searchText,
        }
      )
    )
  }

  async archive(scope: TenantScope, id: string, expectedVersion: number) {
    const result = await trxOf(scope).rawQuery(
      `update dynamic_records
          set archived_at = now(), updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and archived_at is null
        returning ${RECORD_COLUMNS}`,
      [actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    const [row] = result.rows as RecordRow[]
    if (row) return toRecord(row)
    const current = await trxOf(scope).rawQuery(
      'select version, archived_at from dynamic_records where tenant_id = ? and id = ?',
      [tenantOf(scope), id]
    )
    const [existing] = current.rows as { version: number; archived_at: Date | null }[]
    if (!existing) throw ApiError.notFound()
    if (existing.archived_at)
      throw ApiError.conflict('RECORD_ARCHIVED', 'O registo já está arquivado.')
    throw ApiError.versionConflict(existing.version)
  }

  async countActive(scope: TenantScope, entityId: string) {
    const result = await trxOf(scope).rawQuery(
      `select count(*)::int as total from dynamic_records
        where tenant_id = ? and entity_definition_id = ? and archived_at is null`,
      [tenantOf(scope), entityId]
    )
    return (result.rows as { total: number }[])[0].total
  }

  async replaceUniqueKeys(
    scope: TenantScope,
    entityId: string,
    recordId: string,
    keys: { fieldCode: string; key: string }[]
  ) {
    await trxOf(scope).rawQuery(
      'delete from dynamic_unique_values where tenant_id = ? and record_id = ?',
      [tenantOf(scope), recordId]
    )
    const taken: string[] = []
    for (const { fieldCode, key } of keys) {
      // A base é que decide: dois pedidos concorrentes com o mesmo valor não passam.
      const result = await trxOf(scope).rawQuery(
        `insert into dynamic_unique_values
           (tenant_id, entity_definition_id, field_code, value_key, record_id,
            created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (tenant_id, entity_definition_id, field_code, value_key) do nothing
         returning id`,
        [tenantOf(scope), entityId, fieldCode, key, recordId, actorOf(scope), actorOf(scope)]
      )
      if (result.rows.length === 0) taken.push(fieldCode)
    }
    return taken
  }

  async releaseUniqueFields(scope: TenantScope, entityId: string, fieldCodes: string[]) {
    if (fieldCodes.length === 0) return
    await trxOf(scope).rawQuery(
      `delete from dynamic_unique_values
        where tenant_id = ? and entity_definition_id = ? and field_code in (${placeholders(fieldCodes)})`,
      [tenantOf(scope), entityId, ...(fieldCodes as never[])]
    )
  }
}

export class LucidReferenceLookup implements ReferenceLookup {
  async existingRecords(scope: TenantScope, entityId: string, ids: string[]) {
    if (ids.length === 0) return new Set<string>()
    const result = await trxOf(scope).rawQuery(
      `select id from dynamic_records
        where tenant_id = ? and entity_definition_id = ? and archived_at is null
          and id in (${placeholders(ids)})`,
      [tenantOf(scope), entityId, ...(ids as never[])]
    )
    return new Set((result.rows as { id: string }[]).map((r) => r.id))
  }

  async activeMemberships(scope: TenantScope, ids: string[]) {
    if (ids.length === 0) return new Set<string>()
    const result = await trxOf(scope).rawQuery(
      `select id from tenant_memberships
        where tenant_id = ? and status = 'ACTIVE' and id in (${placeholders(ids)})`,
      [tenantOf(scope), ...(ids as never[])]
    )
    return new Set((result.rows as { id: string }[]).map((r) => r.id))
  }

  async activeUnit(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      'select 1 from organization_units where tenant_id = ? and id = ? and active',
      [tenantOf(scope), id]
    )
    return result.rows.length > 0
  }
}
