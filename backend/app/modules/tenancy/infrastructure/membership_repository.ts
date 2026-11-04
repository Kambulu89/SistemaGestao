import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { ApiError } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import type { TenantScope } from '#modules/tenancy/infrastructure/tenant_database'

export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED'

export interface Member {
  id: string
  userId: string
  email: string
  fullName: string
  status: MembershipStatus
  joinedAt: Date | null
  invitedAt: Date | null
  version: number
}

interface MemberRow {
  id: string
  user_id: string
  email: string
  full_name: string
  status: MembershipStatus
  joined_at: Date | null
  invited_at: Date | null
  version: number
}

const SELECT = `select m.id, m.user_id, u.email, u.full_name, m.status, m.joined_at, m.invited_at, m.version
                  from tenant_memberships m join users u on u.id = m.user_id`
const toMember = (r: MemberRow): Member => ({
  id: r.id,
  userId: r.user_id,
  email: r.email,
  fullName: r.full_name,
  status: r.status,
  joinedAt: r.joined_at,
  invitedAt: r.invited_at,
  version: r.version,
})

/** Memberships do tenant em contexto (dono: tenancy). */
export class MembershipRepository {
  async list(
    { trx, context }: TenantScope,
    filter: { status?: MembershipStatus; q?: string; limit: number; offset: number }
  ) {
    const where = ['m.tenant_id = ?']
    const params: unknown[] = [context.tenantId]
    if (filter.status) {
      where.push('m.status = ?')
      params.push(filter.status)
    }
    if (filter.q) {
      const like = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push('(lower(u.email) like ? or lower(u.full_name) like ?)')
      params.push(like, like)
    }
    const clause = where.join(' and ')
    const rows = await trx.rawQuery(
      `${SELECT} where ${clause} order by lower(u.full_name) limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trx.rawQuery(
      `select count(*)::int as total from tenant_memberships m join users u on u.id = m.user_id where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as MemberRow[]).map(toMember),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find({ trx, context }: TenantScope, id: string, lock = false): Promise<Member | null> {
    if (lock) {
      await trx.rawQuery(
        'select id from tenant_memberships where tenant_id = ? and id = ? for update',
        [context.tenantId, id]
      )
    }
    const result = await trx.rawQuery(`${SELECT} where m.tenant_id = ? and m.id = ?`, [
      context.tenantId,
      id,
    ])
    const [row] = result.rows as MemberRow[]
    return row ? toMember(row) : null
  }

  async findByUser({ trx, context }: TenantScope, userId: string): Promise<Member | null> {
    const result = await trx.rawQuery(`${SELECT} where m.tenant_id = ? and m.user_id = ?`, [
      context.tenantId,
      userId,
    ])
    const [row] = result.rows as MemberRow[]
    return row ? toMember(row) : null
  }

  async insertInvited({ trx, context }: TenantScope, userId: string): Promise<string> {
    try {
      await trx.rawQuery('savepoint membership_insert')
      const result = await trx.rawQuery(
        `insert into tenant_memberships (tenant_id, user_id, status, invited_by, invited_at, created_by)
         values (?, ?, 'INVITED', ?, now(), ?) returning id`,
        [context.tenantId, userId, context.userId, context.userId]
      )
      await trx.rawQuery('release savepoint membership_insert')
      return (result.rows[0] as { id: string }).id
    } catch (error) {
      if (constraintOf(error) === 'tenant_memberships_user_unique') {
        await trx.rawQuery('rollback to savepoint membership_insert')
        throw ApiError.conflict(
          'ALREADY_MEMBER',
          'Esta pessoa já pertence (ou foi convidada) a esta empresa.'
        )
      }
      throw error
    }
  }

  /** Membership activa com id escolhido pelo chamador (o primeiro administrador de um tenant novo). */
  async insertActive({ trx, context }: TenantScope, id: string, userId: string) {
    await trx.rawQuery(
      `insert into tenant_memberships (id, tenant_id, user_id, status, joined_at) values (?, ?, ?, 'ACTIVE', now())`,
      [id, context.tenantId, userId]
    )
  }

  async setStatus(
    { trx, context }: TenantScope,
    id: string,
    expectedVersion: number,
    status: MembershipStatus
  ) {
    const result = await trx.rawQuery(
      `update tenant_memberships set status = ?, updated_by = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [status, context.userId, context.tenantId, id, expectedVersion]
    )
    if (result.rows.length === 0) {
      const current = await this.find({ trx, context }, id)
      if (!current) throw ApiError.notFound()
      throw ApiError.versionConflict(current.version)
    }
  }

  /** Activa uma membership convidada dentro da transacção do convite (define o tenant para a RLS). */
  async activateInvited(
    trx: TransactionClientContract,
    tenantId: string,
    membershipId: string,
    userId: string
  ) {
    await trx.rawQuery(`select set_config('app.tenant_id', ?, true)`, [tenantId])
    const result = await trx.rawQuery(
      `update tenant_memberships set status = 'ACTIVE', joined_at = now(), updated_at = now(), version = version + 1
        where tenant_id = ? and id = ? and user_id = ? and status = 'INVITED' returning id`,
      [tenantId, membershipId, userId]
    )
    if (result.rows.length === 0) {
      throw ApiError.conflict('INVITATION_NOT_PENDING', 'O convite já não está pendente.')
    }
  }
}
