import db from '@adonisjs/lucid/services/db'
import type { Tenant, TenantDomain, TenantStatus } from '#platform/tenants/domain/tenant'
import type { TenantStore } from '#platform/tenants/application/ports'

const conn = () => db.connection('runtime')

interface TenantRow {
  id: string
  code: string
  name: string
  status: TenantStatus
  default_locale: string
  timezone: string
  version: number
}

interface DomainRow {
  id: string
  tenant_id: string
  hostname: string
  is_primary: boolean
  verified_at: Date | null
  verification_token_hash: string | null
}

const toTenant = (row: TenantRow): Tenant => ({
  id: row.id,
  code: row.code,
  name: row.name,
  status: row.status,
  defaultLocale: row.default_locale,
  timezone: row.timezone,
  version: row.version,
})

const toDomain = (row: DomainRow): TenantDomain & { verificationTokenHash: string | null } => ({
  id: row.id,
  tenantId: row.tenant_id,
  hostname: row.hostname,
  isPrimary: row.is_primary,
  verifiedAt: row.verified_at,
  verificationTokenHash: row.verification_token_hash,
})

export class LucidTenantStore implements TenantStore {
  async insert(input: { code: string; name: string; defaultLocale?: string; timezone?: string }) {
    const result = await conn().rawQuery(
      `insert into tenants (code, name, default_locale, timezone)
       values (?, ?, coalesce(?, 'pt-AO'), coalesce(?, 'Africa/Luanda'))
       on conflict (code) do nothing
       returning *`,
      [
        input.code,
        input.name,
        (input.defaultLocale ?? null) as string,
        (input.timezone ?? null) as string,
      ]
    )
    const [row] = result.rows as TenantRow[]
    return row ? toTenant(row) : null
  }

  async findByCode(code: string) {
    const row = await conn().from('tenants').where('code', code).first()
    return row ? toTenant(row) : null
  }

  async findById(id: string) {
    const row = await conn().from('tenants').where('id', id).first()
    return row ? toTenant(row) : null
  }

  async findByIds(ids: string[]) {
    if (ids.length === 0) return []
    const rows = await conn().from('tenants').whereIn('id', ids)
    return (rows as TenantRow[]).map(toTenant)
  }

  async updateStatus(id: string, status: TenantStatus, expectedVersion: number, now: Date) {
    const result = await conn().rawQuery(
      `update tenants
          set status = ?, version = version + 1, updated_at = ?,
              activated_at = case when ? = 'ACTIVE' then coalesce(activated_at, ?) else activated_at end
        where id = ? and version = ?
        returning *`,
      [status, now, status, now, id, expectedVersion]
    )
    const [row] = result.rows as TenantRow[]
    return row ? toTenant(row) : null
  }

  async insertDomain(input: {
    tenantId: string
    hostname: string
    verificationTokenHash: string
    isPrimary: boolean
  }) {
    const result = await conn().rawQuery(
      `insert into tenant_domains (tenant_id, hostname, verification_token_hash, is_primary)
       values (?, ?, ?, ?)
       on conflict (hostname) do nothing
       returning *`,
      [input.tenantId, input.hostname, input.verificationTokenHash, input.isPrimary]
    )
    const [row] = result.rows as DomainRow[]
    return row ? toDomain(row) : null
  }

  async findDomainByHostname(hostname: string) {
    const row = await conn().from('tenant_domains').where('hostname', hostname).first()
    return row ? toDomain(row) : null
  }

  async markDomainVerified(id: string, now: Date) {
    await conn()
      .from('tenant_domains')
      .where('id', id)
      .update({ verified_at: now, verification_token_hash: null, updated_at: now })
  }

  async hasDomains(tenantId: string) {
    const row = await conn().from('tenant_domains').where('tenant_id', tenantId).first()
    return !!row
  }
}
