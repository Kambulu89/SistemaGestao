import { randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { hashToken } from '#modules/identity/infrastructure/session_repository'

export type TokenPurpose = 'INVITATION' | 'PASSWORD_RESET'

export interface OneTimeToken {
  id: string
  userId: string
  purpose: TokenPurpose
  tenantId: string | null
  membershipId: string | null
  expiresAt: Date
}

const conn = () => db.connection('runtime')

/** Tokens de uso único (só o SHA-256 é guardado); consumir é atómico e só resulta uma vez. */
export class TokenRepository {
  async issue(input: {
    userId: string
    purpose: TokenPurpose
    ttlMinutes: number
    tenantId?: string
    membershipId?: string
  }): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    await conn().rawQuery(
      `update one_time_tokens set consumed_at = now()
        where user_id = ? and purpose = ? and consumed_at is null and coalesce(tenant_id::text, '') = coalesce(?::text, '')`,
      [input.userId, input.purpose, input.tenantId ?? null] as never[]
    )
    await conn().rawQuery(
      `insert into one_time_tokens (user_id, purpose, tenant_id, membership_id, token_hash, expires_at)
       values (?, ?, ?, ?, ?, now() + make_interval(mins => ?))`,
      [
        input.userId,
        input.purpose,
        input.tenantId ?? null,
        input.membershipId ?? null,
        hashToken(token),
        input.ttlMinutes,
      ] as never[]
    )
    return token
  }

  /** Consome o token dentro da transacção dada; devolve `null` se não existe, expirou ou já foi usado. */
  async consume(
    trx: TransactionClientContract,
    token: string,
    purpose: TokenPurpose
  ): Promise<OneTimeToken | null> {
    const result = await trx.rawQuery(
      `update one_time_tokens set consumed_at = now(), updated_at = now()
        where token_hash = ? and purpose = ? and consumed_at is null and expires_at > now()
        returning id, user_id, purpose, tenant_id, membership_id, expires_at`,
      [hashToken(token), purpose]
    )
    const [row] = result.rows as {
      id: string
      user_id: string
      purpose: TokenPurpose
      tenant_id: string | null
      membership_id: string | null
      expires_at: Date
    }[]
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          purpose: row.purpose,
          tenantId: row.tenant_id,
          membershipId: row.membership_id,
          expiresAt: row.expires_at,
        }
      : null
  }
}
