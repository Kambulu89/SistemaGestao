import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import {
  LucidTenantScope,
  TenantRepository,
  type TenantRow,
  type TenantScope,
} from '#core/tenancy/index'
import type { Membership, MembershipStatus } from '#core/membership/domain/membership'
import type { MembershipDirectory, MembershipStore } from '#core/membership/application/ports'

interface MembershipRow extends TenantRow {
  user_id: string
  person_id: string | null
  default_organization_id: string | null
  status: MembershipStatus
  joined_at: Date | null
  authorization_version: number
}

const toMembership = (row: MembershipRow): Membership => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  status: row.status,
  joinedAt: row.joined_at,
  defaultOrganizationId: row.default_organization_id,
  authorizationVersion: row.authorization_version,
  version: row.version,
})

class MembershipRows extends TenantRepository<MembershipRow> {
  protected readonly table = 'tenant_memberships'
}

/**
 * Lê as memberships do utilizador autenticado. Define `app.user_id` (local à transacção) para a
 * política `tenant_memberships_self_read`: a base só devolve linhas desse utilizador, e o filtro
 * explícito por `user_id` repete o controlo na aplicação.
 */
export class LucidMembershipDirectory implements MembershipDirectory {
  async listForUser(userId: string) {
    return this.asUser(userId, (trx) =>
      trx.from('tenant_memberships').where('user_id', userId).orderBy('created_at')
    )
  }

  async findForUser(userId: string, tenantId: string) {
    const rows = await this.asUser(userId, (trx) =>
      trx.from('tenant_memberships').where({ user_id: userId, tenant_id: tenantId })
    )
    return rows[0] ?? null
  }

  private async asUser(
    userId: string,
    query: (trx: TransactionClientContract) => PromiseLike<unknown>
  ): Promise<Membership[]> {
    return conn().transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.user_id', ?, true)", [userId])
      const rows = (await query(trx)) as MembershipRow[]
      return rows.map(toMembership)
    })
  }
}

const conn = () => db.connection('runtime')

export class LucidMembershipStore implements MembershipStore {
  private readonly rows = new MembershipRows()

  async insert(scope: TenantScope, input: { userId: string; status: MembershipStatus }) {
    const { trx, context } = scope as LucidTenantScope
    const result = await trx.rawQuery(
      `insert into tenant_memberships (tenant_id, user_id, status, joined_at, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, case when ? = 'ACTIVE' then now() else null end, ?, ?)
       on conflict (tenant_id, user_id) do nothing
       returning *`,
      [
        context.tenantId,
        input.userId,
        input.status,
        input.status,
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    const [row] = result.rows as MembershipRow[]
    return row ? toMembership(row) : null
  }

  async findByUser(scope: TenantScope, userId: string) {
    const { trx, context } = scope as LucidTenantScope
    const row = await trx
      .from('tenant_memberships')
      .where({ tenant_id: context.tenantId, user_id: userId })
      .first()
    return row ? toMembership(row as MembershipRow) : null
  }

  async changeStatus(scope: TenantScope, membership: Membership, status: MembershipStatus) {
    const updated = await this.rows.update(scope, membership.id, membership.version, {
      status,
      authorization_version: membership.authorizationVersion + 1,
      ...(status === 'ACTIVE' && !membership.joinedAt ? { joined_at: new Date() } : {}),
    })
    return toMembership(updated)
  }
}
