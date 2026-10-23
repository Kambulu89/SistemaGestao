import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type { FormMode, FormSection, FormStatus } from '#dynamic/forms/domain/form'
import type { Form, FormStore, FormValues } from '#dynamic/forms/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never
const json = (value: unknown) => JSON.stringify(value)

interface FormRow {
  id: string
  entity_definition_id: string
  entity_code: string
  code: string
  name: string
  description: string | null
  revision: number
  status: FormStatus
  modes: FormMode[]
  is_default: boolean
  layout: { sections: FormSection[] }
  schema_revision: number | null
  published_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

/** `f.*` com o código da entidade (o formulário aponta para a entidade por id). */
const SELECT = `select f.id, f.entity_definition_id, e.code as entity_code, f.code, f.name, f.description,
  f.revision, f.status, f.modes, f.is_default, f.layout, f.schema_revision, f.published_at, f.version,
  f.created_at, f.updated_at
  from form_definitions f
  join entity_definitions e on e.tenant_id = f.tenant_id and e.id = f.entity_definition_id`

const toForm = (r: FormRow): Form => ({
  id: r.id,
  entityDefinitionId: r.entity_definition_id,
  entityCode: r.entity_code,
  code: r.code,
  name: r.name,
  description: r.description,
  revision: r.revision,
  status: r.status,
  modes: r.modes,
  isDefault: r.is_default,
  sections: r.layout.sections,
  schemaRevision: r.schema_revision,
  publishedAt: r.published_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidFormStore implements FormStore {
  async list(scope: TenantScope, filter: { entityDefinitionId?: string; status?: FormStatus }) {
    const where = ['f.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.entityDefinitionId) {
      where.push('f.entity_definition_id = ?')
      params.push(filter.entityDefinitionId)
    }
    if (filter.status) {
      where.push('f.status = ?')
      params.push(filter.status)
    }
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where ${where.join(' and ')} order by e.code, f.code, f.revision desc`,
      params as never[]
    )
    return (result.rows as FormRow[]).map(toForm)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(`${SELECT} where f.tenant_id = ? and f.id = ?`, [
      tenantOf(scope),
      id,
    ])
    const [row] = result.rows as FormRow[]
    return row ? toForm(row) : null
  }

  async latest(scope: TenantScope, entityDefinitionId: string, code: string) {
    const result = await trxOf(scope).rawQuery(
      `${SELECT} where f.tenant_id = ? and f.entity_definition_id = ? and f.code = ?
        order by f.revision desc limit 1`,
      [tenantOf(scope), entityDefinitionId, code]
    )
    const [row] = result.rows as FormRow[]
    return row ? toForm(row) : null
  }

  async insert(scope: TenantScope, v: FormValues & { revision: number }) {
    const result = await trxOf(scope).rawQuery(
      `insert into form_definitions
         (tenant_id, entity_definition_id, code, name, description, revision, modes, is_default, layout,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?, ?)
       on conflict do nothing
       returning id`,
      [
        tenantOf(scope),
        v.entityDefinitionId,
        v.code,
        v.name,
        v.description as never,
        v.revision,
        json(v.modes),
        v.isDefault,
        json({ sections: v.sections }),
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<FormValues, 'entityDefinitionId' | 'code'>>
  ) {
    const columns: [string, unknown][] = [
      ['name', patch.name],
      ['description', patch.description],
      ['modes', patch.modes === undefined ? undefined : `${json(patch.modes)}`],
      ['is_default', patch.isDefault],
      ['layout', patch.sections === undefined ? undefined : json({ sections: patch.sections })],
    ]
    const entries = columns.filter(([, value]) => value !== undefined)
    const sets = entries
      .map(([column]) =>
        column === 'modes' || column === 'layout' ? `"${column}" = ?::jsonb` : `"${column}" = ?`
      )
      .join(', ')
    const result = await trxOf(scope).rawQuery(
      `update form_definitions
          set ${sets}${sets ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'DRAFT'
        returning id`,
      [...entries.map(([, v]) => v as never), actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async publish(scope: TenantScope, form: Form, schemaRevision: number, expectedVersion: number) {
    await trxOf(scope).rawQuery(
      `update form_definitions set status = 'RETIRED', updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and entity_definition_id = ? and code = ? and status = 'PUBLISHED'`,
      [actorOf(scope), tenantOf(scope), form.entityDefinitionId, form.code]
    )
    const result = await trxOf(scope).rawQuery(
      `update form_definitions
          set status = 'PUBLISHED', published_at = now(), published_by_membership_id = ?, schema_revision = ?,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'DRAFT'
        returning id`,
      [actorOf(scope), schemaRevision, actorOf(scope), tenantOf(scope), form.id, expectedVersion]
    )
    return this.afterWrite(scope, form.id, result.rows.length > 0)
  }

  async retire(scope: TenantScope, id: string, expectedVersion: number) {
    const result = await trxOf(scope).rawQuery(
      `update form_definitions set status = 'RETIRED', updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'PUBLISHED'
        returning id`,
      [actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  /** Lê o formulário depois de uma escrita com controlo de versão: 404 se não existe, 409 se a versão mudou. */
  private async afterWrite(scope: TenantScope, id: string, written: boolean): Promise<Form> {
    const form = await this.find(scope, id)
    if (!form) throw ApiError.notFound()
    if (!written) throw ApiError.versionConflict(form.version)
    return form
  }
}
