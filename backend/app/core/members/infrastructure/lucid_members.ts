import {
  LucidTenantScope,
  TenantRepository,
  type TenantRow,
  type TenantScope,
} from '#core/tenancy/index'
import type { Invitation, InvitationStatus } from '#core/members/domain/invitation'
import type { InvitationStore, PreferenceStore } from '#core/members/application/ports'

interface InvitationRow extends TenantRow {
  email: string
  token_hash: string
  invited_by_membership_id: string | null
  expires_at: Date
  accepted_at: Date | null
  status: InvitationStatus
  role_ids: string[]
  unit_ids: string[]
}

class Invitations extends TenantRepository<InvitationRow> {
  protected readonly table = 'invitations'
}

const toInvitation = (r: InvitationRow): Invitation => ({
  id: r.id,
  email: r.email,
  invitedByMembershipId: r.invited_by_membership_id,
  expiresAt: r.expires_at,
  acceptedAt: r.accepted_at,
  status: r.status,
  roleIds: r.role_ids,
  unitIds: r.unit_ids,
  version: r.version,
})

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const contextOf = (scope: TenantScope) => (scope as LucidTenantScope).context

export class LucidInvitationStore implements InvitationStore {
  private readonly rows = new Invitations()

  async insert(
    scope: TenantScope,
    input: {
      email: string
      tokenHash: string
      invitedByMembershipId: string | null
      expiresAt: Date
      roleIds: string[]
      unitIds: string[]
    }
  ) {
    const context = contextOf(scope)
    const result = await trxOf(scope).rawQuery(
      `insert into invitations
         (tenant_id, email, token_hash, invited_by_membership_id, expires_at, role_ids, unit_ids,
          created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
       on conflict do nothing
       returning *`,
      [
        context.tenantId,
        input.email,
        input.tokenHash,
        input.invitedByMembershipId as string,
        input.expiresAt,
        JSON.stringify(input.roleIds),
        JSON.stringify(input.unitIds),
        context.membershipId as string,
        context.membershipId as string,
      ]
    )
    const [row] = result.rows as InvitationRow[]
    return row ? toInvitation(row) : null
  }

  async expirePending(scope: TenantScope, email: string, now: Date) {
    await trxOf(scope)
      .from('invitations')
      .where({ tenant_id: contextOf(scope).tenantId, email, status: 'PENDING' })
      .where('expires_at', '<=', now)
      .update({ status: 'EXPIRED', updated_at: now })
  }

  async list(scope: TenantScope) {
    const rows = await this.rows.list(scope, { limit: 100 })
    return rows.map(toInvitation)
  }

  async findById(scope: TenantScope, id: string) {
    const row = await this.rows.findById(scope, id)
    return row ? toInvitation(row) : null
  }

  async findByHash(scope: TenantScope, tokenHash: string) {
    const row = await trxOf(scope)
      .from('invitations')
      .where({ tenant_id: contextOf(scope).tenantId, token_hash: tokenHash })
      .first()
    return row ? toInvitation(row as InvitationRow) : null
  }

  async setStatus(
    scope: TenantScope,
    invitation: Invitation,
    status: 'ACCEPTED' | 'REVOKED',
    now: Date
  ) {
    await this.rows.update(scope, invitation.id, invitation.version, {
      status,
      ...(status === 'ACCEPTED' ? { accepted_at: now } : {}),
    })
  }
}

export class LucidPreferenceStore implements PreferenceStore {
  async list(scope: TenantScope, membershipId: string) {
    const rows = await trxOf(scope)
      .from('user_preferences')
      .where({ tenant_id: contextOf(scope).tenantId, membership_id: membershipId })
      .orderBy('key')
    return Object.fromEntries(rows.map((r) => [r.key as string, r.value as unknown]))
  }

  async upsert(scope: TenantScope, membershipId: string, key: string, value: unknown) {
    const context = contextOf(scope)
    await trxOf(scope).rawQuery(
      `insert into user_preferences
         (tenant_id, membership_id, key, value, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?::jsonb, ?, ?)
       on conflict (tenant_id, membership_id, key)
       do update set value = excluded.value, updated_at = now(), version = user_preferences.version + 1`,
      [context.tenantId, membershipId, key, JSON.stringify(value), membershipId, membershipId]
    )
  }

  async remove(scope: TenantScope, membershipId: string, key: string) {
    const rows = await trxOf(scope)
      .from('user_preferences')
      .where({ tenant_id: contextOf(scope).tenantId, membership_id: membershipId, key })
      .delete()
      .returning('id')
    return rows.length > 0
  }
}
