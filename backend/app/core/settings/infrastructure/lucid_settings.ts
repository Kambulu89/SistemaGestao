import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type { ScopeRef, StoredValue } from '#core/settings/domain/setting'
import type {
  BranchRef,
  OrganizationRef,
  ReferenceLookup,
  Sequence,
  SequenceStore,
  SequenceValues,
  SettingStore,
  TaxRate,
  TaxRateStore,
  TaxRateValues,
  Unit,
  UnitStore,
  UnitValues,
} from '#core/settings/application/ports'

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const lucid = (scope: TenantScope) => scope as LucidTenantScope
const trxOf = (scope: TenantScope) => lucid(scope).trx
const ctxOf = (scope: TenantScope) => lucid(scope).context
const tenantOf = (scope: TenantScope) => ctxOf(scope).tenantId
const actorOf = (scope: TenantScope) => ctxOf(scope).membershipId as never

const isCode = (error: unknown, code: string) => (error as { code?: string }).code === code

async function advisoryLock(scope: TenantScope, name: string) {
  await trxOf(scope).rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
    `${name}:${tenantOf(scope)}`,
  ])
}

/**
 * `UPDATE` com controlo de versão (como o `TenantRepository`): 404 se a linha não existe neste tenant,
 * 409 `VERSION_CONFLICT` se a versão mudou.
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
  const found = (current.rows as { version: number }[])[0]
  if (!found) throw ApiError.notFound()
  throw ApiError.versionConflict(found.version)
}

// --- referências --------------------------------------------------------------------------------

export class LucidReferenceLookup implements ReferenceLookup {
  async organization(scope: TenantScope, id: string): Promise<OrganizationRef | null> {
    const result = await trxOf(scope).rawQuery(
      'select id, code from organizations where tenant_id = ? and id = ?',
      [tenantOf(scope), id]
    )
    return (result.rows as OrganizationRef[])[0] ?? null
  }

  async branch(scope: TenantScope, id: string): Promise<BranchRef | null> {
    const result = await trxOf(scope).rawQuery(
      `select id, code, organization_id as "organizationId", type
         from organization_units where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    return (result.rows as BranchRef[])[0] ?? null
  }

  async membershipExists(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      'select 1 from tenant_memberships where tenant_id = ? and id = ?',
      [tenantOf(scope), id]
    )
    return result.rows.length > 0
  }
}

// --- configurações ------------------------------------------------------------------------------

interface SettingRow {
  key: string
  scope_type: StoredValue['scopeType']
  scope_id: string | null
  module_code: string | null
  value: unknown
  version: number
}

const toStored = (r: SettingRow): StoredValue => ({
  key: r.key,
  scopeType: r.scope_type,
  scopeId: r.scope_id,
  moduleCode: r.module_code,
  value: r.value,
  version: r.version,
})

const SETTING_COLUMNS = 'key, scope_type, scope_id, module_code, value, version'
const sameScope = `scope_type = ? and coalesce(scope_id, '${ZERO_UUID}'::uuid) = ?::uuid and coalesce(module_code, '') = ?`
const scopeParams = (ref: ScopeRef) => [
  ref.scopeType,
  ref.scopeId ?? ZERO_UUID,
  ref.moduleCode ?? '',
]

export class LucidSettingStore implements SettingStore {
  lock(scope: TenantScope) {
    return advisoryLock(scope, 'settings')
  }

  async list(scope: TenantScope, filter: { key?: string; scopeType?: string }) {
    const clauses = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.key) {
      clauses.push('key = ?')
      params.push(filter.key)
    }
    if (filter.scopeType) {
      clauses.push('scope_type = ?')
      params.push(filter.scopeType)
    }
    const result = await trxOf(scope).rawQuery(
      `select ${SETTING_COLUMNS} from setting_values where ${clauses.join(' and ')} order by key, scope_type, id`,
      params as never
    )
    return (result.rows as SettingRow[]).map(toStored)
  }

  forResolution(scope: TenantScope) {
    return this.list(scope, {})
  }

  async find(scope: TenantScope, key: string, ref: ScopeRef) {
    const result = await trxOf(scope).rawQuery(
      `select ${SETTING_COLUMNS} from setting_values where tenant_id = ? and key = ? and ${sameScope}`,
      [tenantOf(scope), key, ...scopeParams(ref)]
    )
    const [row] = result.rows as SettingRow[]
    return row ? toStored(row) : null
  }

  async insert(scope: TenantScope, key: string, ref: ScopeRef, value: unknown) {
    const result = await trxOf(scope).rawQuery(
      `insert into setting_values
         (tenant_id, key, scope_type, scope_id, module_code, value, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?, ?)
       returning ${SETTING_COLUMNS}`,
      [
        tenantOf(scope),
        key,
        ref.scopeType,
        ref.scopeId as never,
        ref.moduleCode as never,
        JSON.stringify(value),
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toStored((result.rows as SettingRow[])[0])
  }

  async update(
    scope: TenantScope,
    key: string,
    ref: ScopeRef,
    value: unknown,
    expectedVersion: number
  ) {
    const result = await trxOf(scope).rawQuery(
      `update setting_values
          set value = ?::jsonb, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and key = ? and ${sameScope} and version = ?
        returning ${SETTING_COLUMNS}`,
      [
        JSON.stringify(value),
        actorOf(scope),
        tenantOf(scope),
        key,
        ...scopeParams(ref),
        expectedVersion,
      ]
    )
    const [row] = result.rows as SettingRow[]
    return row ? toStored(row) : null
  }

  async delete(scope: TenantScope, key: string, ref: ScopeRef) {
    const result = await trxOf(scope).rawQuery(
      `delete from setting_values where tenant_id = ? and key = ? and ${sameScope}`,
      [tenantOf(scope), key, ...scopeParams(ref)]
    )
    return (result.rowCount ?? 0) > 0
  }
}

// --- impostos -----------------------------------------------------------------------------------

interface TaxRow {
  id: string
  organization_id: string
  code: string
  name: string
  rate: string
  valid_from: string
  valid_to: string | null
  category: string
  exemption_reason: string | null
  version: number
}

const TAX_COLUMNS = `id, organization_id, code, name, rate::text as rate, valid_from::text as valid_from,
  valid_to::text as valid_to, category, exemption_reason, version`

const toTax = (r: TaxRow): TaxRate => ({
  id: r.id,
  organizationId: r.organization_id,
  code: r.code,
  name: r.name,
  rate: r.rate,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  category: r.category,
  exemptionReason: r.exemption_reason,
  version: r.version,
})

export class LucidTaxRateStore implements TaxRateStore {
  async list(scope: TenantScope, filter: { organizationId?: string; code?: string; on?: string }) {
    const clauses = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.organizationId) {
      clauses.push('organization_id = ?')
      params.push(filter.organizationId)
    }
    if (filter.code) {
      clauses.push('code = ?')
      params.push(filter.code.toUpperCase())
    }
    if (filter.on) {
      clauses.push('valid_from <= ?::date and (valid_to is null or valid_to >= ?::date)')
      params.push(filter.on, filter.on)
    }
    const result = await trxOf(scope).rawQuery(
      `select ${TAX_COLUMNS} from tax_rates where ${clauses.join(' and ')}
        order by organization_id, code, valid_from`,
      params as never
    )
    return (result.rows as TaxRow[]).map(toTax)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${TAX_COLUMNS} from tax_rates where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as TaxRow[]
    return row ? toTax(row) : null
  }

  async insert(scope: TenantScope, v: TaxRateValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into tax_rates
           (tenant_id, organization_id, code, name, rate, valid_from, valid_to, category, exemption_reason,
            created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         returning ${TAX_COLUMNS}`,
        [
          tenantOf(scope),
          v.organizationId,
          v.code,
          v.name,
          v.rate,
          v.validFrom,
          v.validTo as never,
          v.category,
          v.exemptionReason as never,
          actorOf(scope),
          actorOf(scope),
        ]
      )
      return toTax((result.rows as TaxRow[])[0])
    } catch (error) {
      if (isCode(error, '23P01')) return 'OVERLAP' as const
      throw error
    }
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<TaxRateValues, 'name' | 'validTo' | 'category' | 'exemptionReason'>>
  ) {
    try {
      const row = await versionedUpdate<TaxRow>(
        scope,
        'tax_rates',
        TAX_COLUMNS,
        id,
        expectedVersion,
        {
          name: patch.name?.trim(),
          valid_to: patch.validTo,
          category: patch.category?.trim(),
          exemption_reason: patch.exemptionReason,
        }
      )
      return toTax(row)
    } catch (error) {
      if (isCode(error, '23P01')) return 'OVERLAP' as const
      throw error
    }
  }
}

// --- unidades -----------------------------------------------------------------------------------

interface UnitRow {
  id: string
  code: string
  name: string
  dimension: string
  precision: number
  base_unit_id: string | null
  conversion_factor: string | null
  version: number
}

const UNIT_COLUMNS =
  'id, code, name, dimension, "precision", base_unit_id, conversion_factor::text as conversion_factor, version'

const toUnit = (r: UnitRow): Unit => ({
  id: r.id,
  code: r.code,
  name: r.name,
  dimension: r.dimension,
  precision: r.precision,
  baseUnitId: r.base_unit_id,
  factor: r.conversion_factor,
  version: r.version,
})

export class LucidUnitStore implements UnitStore {
  lock(scope: TenantScope) {
    return advisoryLock(scope, 'units')
  }

  async list(scope: TenantScope) {
    const result = await trxOf(scope).rawQuery(
      `select ${UNIT_COLUMNS} from units_of_measure where tenant_id = ? order by dimension, code`,
      [tenantOf(scope)]
    )
    return (result.rows as UnitRow[]).map(toUnit)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${UNIT_COLUMNS} from units_of_measure where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as UnitRow[]
    return row ? toUnit(row) : null
  }

  async findByCode(scope: TenantScope, code: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${UNIT_COLUMNS} from units_of_measure where tenant_id = ? and code = ?`,
      [tenantOf(scope), code]
    )
    const [row] = result.rows as UnitRow[]
    return row ? toUnit(row) : null
  }

  async insert(scope: TenantScope, v: UnitValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into units_of_measure
         (tenant_id, code, name, dimension, "precision", base_unit_id, conversion_factor,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, code) do nothing
       returning ${UNIT_COLUMNS}`,
      [
        tenantOf(scope),
        v.code,
        v.name,
        v.dimension,
        v.precision,
        v.baseUnitId as never,
        v.factor as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [row] = result.rows as UnitRow[]
    return row ? toUnit(row) : null
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: { name?: string; precision?: number }
  ) {
    return toUnit(
      await versionedUpdate<UnitRow>(scope, 'units_of_measure', UNIT_COLUMNS, id, expectedVersion, {
        name: patch.name,
        precision: patch.precision,
      })
    )
  }
}

// --- sequências ---------------------------------------------------------------------------------

interface SequenceRow {
  id: string
  organization_id: string
  branch_id: string | null
  document_type: string
  series: string
  period: string
  prefix_template: string
  next_value: string
  padding: number
  version: number
}

const SEQUENCE_COLUMNS = `id, organization_id, branch_id, document_type, series, period, prefix_template,
  next_value::text as next_value, padding, version`

const toSequence = (r: SequenceRow): Sequence => ({
  id: r.id,
  organizationId: r.organization_id,
  branchId: r.branch_id,
  documentType: r.document_type,
  series: r.series,
  period: r.period,
  prefixTemplate: r.prefix_template,
  nextValue: r.next_value,
  padding: r.padding,
  version: r.version,
})

export class LucidSequenceStore implements SequenceStore {
  async list(scope: TenantScope, filter: { organizationId?: string; documentType?: string }) {
    const clauses = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.organizationId) {
      clauses.push('organization_id = ?')
      params.push(filter.organizationId)
    }
    if (filter.documentType) {
      clauses.push('document_type = ?')
      params.push(filter.documentType)
    }
    const result = await trxOf(scope).rawQuery(
      `select ${SEQUENCE_COLUMNS} from sequences where ${clauses.join(' and ')}
        order by document_type, series, period, id`,
      params as never
    )
    return (result.rows as SequenceRow[]).map(toSequence)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${SEQUENCE_COLUMNS} from sequences where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as SequenceRow[]
    return row ? toSequence(row) : null
  }

  async insert(scope: TenantScope, v: SequenceValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into sequences
         (tenant_id, organization_id, branch_id, document_type, series, period, prefix_template,
          next_value, padding, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?::bigint, ?, ?, ?)
       on conflict do nothing
       returning ${SEQUENCE_COLUMNS}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.branchId as never,
        v.documentType,
        v.series,
        v.period,
        v.prefixTemplate,
        v.nextValue,
        v.padding,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [row] = result.rows as SequenceRow[]
    return row ? toSequence(row) : null
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: { prefixTemplate?: string; padding?: number; nextValue?: string }
  ) {
    return toSequence(
      await versionedUpdate<SequenceRow>(
        scope,
        'sequences',
        SEQUENCE_COLUMNS,
        id,
        expectedVersion,
        {
          prefix_template: patch.prefixTemplate,
          padding: patch.padding,
          next_value: patch.nextValue,
        }
      )
    )
  }

  async resolve(
    scope: TenantScope,
    input: {
      organizationId: string
      branchId: string | null
      documentType: string
      series: string
      periods: readonly string[]
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `select ${SEQUENCE_COLUMNS} from sequences
        where tenant_id = ? and organization_id = ? and document_type = ? and series = ?
          and period in (${input.periods.map(() => '?').join(', ')}) and (branch_id is null or branch_id = ?)`,
      [
        tenantOf(scope),
        input.organizationId,
        input.documentType,
        input.series,
        ...input.periods,
        input.branchId as never,
      ]
    )
    const rows = (result.rows as SequenceRow[]).map(toSequence)
    const branches = input.branchId ? [input.branchId, null] : [null]
    for (const branchId of branches) {
      for (const period of input.periods) {
        const hit = rows.find((s) => s.branchId === branchId && s.period === period)
        if (hit) return hit
      }
    }
    return null
  }

  async allocate(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `update sequences
          set next_value = next_value + 1, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?
        returning (next_value - 1)::text as allocated`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as { allocated: string }[]
    if (!row) throw ApiError.notFound('Sequência não encontrada.')
    return BigInt(row.allocated)
  }
}
