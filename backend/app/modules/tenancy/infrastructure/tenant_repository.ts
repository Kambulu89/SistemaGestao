import db from '@adonisjs/lucid/services/db'
import { ApiError } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import type { Tenant, TenantStatus, TenantValues } from '#modules/tenancy/domain/tenant'

interface TenantRow {
  id: string
  code: string
  name: string
  slug: string
  status: TenantStatus
  country_code: string
  default_currency: string
  locale: string
  timezone: string
  version: number
  created_at: Date
  updated_at: Date
}

const COLUMNS =
  'id, code, name, slug, status, country_code, default_currency, locale, timezone, version, created_at, updated_at'

const toTenant = (r: TenantRow): Tenant => ({
  id: r.id,
  code: r.code,
  name: r.name,
  slug: r.slug,
  status: r.status,
  countryCode: r.country_code,
  defaultCurrency: r.default_currency,
  locale: r.locale,
  timezone: r.timezone,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const conn = () => db.connection('runtime')

/** Tenants (tabela global do plano de controlo). Só a administração da plataforma escreve aqui. */
export class TenantRepository {
  async find(id: string): Promise<Tenant | null> {
    const result = await conn().rawQuery(`select ${COLUMNS} from tenants where id = ?`, [id])
    const [row] = result.rows as TenantRow[]
    return row ? toTenant(row) : null
  }

  async findMany(ids: readonly string[]): Promise<Tenant[]> {
    if (ids.length === 0) return []
    const result = await conn().rawQuery(
      `select ${COLUMNS} from tenants where id = any(?::uuid[]) order by name`,
      [ids as string[]]
    )
    return (result.rows as TenantRow[]).map(toTenant)
  }

  async list(filter: { q?: string; status?: TenantStatus; limit: number; offset: number }) {
    const where: string[] = ['true']
    const params: unknown[] = []
    if (filter.q) {
      where.push('(lower(name) like ? or lower(code) like ?)')
      const like = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      params.push(like, like)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    const clause = where.join(' and ')
    const rows = await conn().rawQuery(
      `select ${COLUMNS} from tenants where ${clause} order by name limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await conn().rawQuery(
      `select count(*)::int as total from tenants where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as TenantRow[]).map(toTenant),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async insert(v: TenantValues): Promise<Tenant> {
    try {
      const result = await conn().rawQuery(
        `insert into tenants (code, name, slug, country_code, default_currency, locale, timezone)
         values (?, ?, ?, ?, ?, ?, ?) returning ${COLUMNS}`,
        [v.code, v.name, v.slug, v.countryCode, v.defaultCurrency, v.locale, v.timezone]
      )
      return toTenant(result.rows[0] as TenantRow)
    } catch (error) {
      const constraint = constraintOf(error)
      if (constraint?.includes('code'))
        throw ApiError.conflict('TENANT_CODE_TAKEN', 'Já existe um tenant com este código.')
      if (constraint?.includes('slug'))
        throw ApiError.conflict('TENANT_SLUG_TAKEN', 'Já existe um tenant com este slug.')
      throw error
    }
  }

  async update(
    id: string,
    expectedVersion: number,
    v: TenantValues & { status: TenantStatus }
  ): Promise<Tenant> {
    const result = await conn().rawQuery(
      `update tenants set name = ?, country_code = ?, default_currency = ?, locale = ?, timezone = ?, status = ?,
              version = version + 1, updated_at = now()
        where id = ? and version = ? returning ${COLUMNS}`,
      [
        v.name,
        v.countryCode,
        v.defaultCurrency,
        v.locale,
        v.timezone,
        v.status,
        id,
        expectedVersion,
      ]
    )
    const [row] = result.rows as TenantRow[]
    if (row) return toTenant(row)
    const current = await this.find(id)
    if (!current) throw ApiError.notFound()
    throw ApiError.versionConflict(current.version)
  }
}
