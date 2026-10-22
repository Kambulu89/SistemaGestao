import db from '@adonisjs/lucid/services/db'
import type { AuthSession, User } from '#core/auth/domain/identity'
import type {
  NewSession,
  NewUser,
  OneTimeTokenStore,
  SessionRepository,
  UserRepository,
} from '#core/auth/application/ports'
import type { TokenPurpose } from '#core/auth/domain/identity'

/** Todas as consultas usam a ligação `runtime` (a conta sem privilégios de dono). */
const conn = () => db.connection('runtime')

interface UserRow {
  id: string
  email: string
  display_name: string
  password_hash: string | null
  email_verified_at: Date | null
  status: User['status']
  locale: string | null
}

interface SessionRow {
  id: string
  user_id: string
  expires_at: Date
  revoked_at: Date | null
  last_seen_at: Date
  created_at: Date
  ip: string | null
  user_agent: string | null
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  passwordHash: row.password_hash,
  emailVerifiedAt: row.email_verified_at,
  status: row.status,
  locale: row.locale,
})

const toSession = (row: SessionRow): AuthSession => ({
  id: row.id,
  userId: row.user_id,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  ip: row.ip,
  userAgent: row.user_agent,
})

export class LucidUserRepository implements UserRepository {
  async findByEmail(normalizedEmail: string) {
    const row = await conn().from('users').where('email', normalizedEmail).first()
    return row ? toUser(row) : null
  }

  async findById(id: string) {
    const row = await conn().from('users').where('id', id).first()
    return row ? toUser(row) : null
  }

  async findByIds(ids: readonly string[]) {
    if (ids.length === 0) return []
    const rows = await conn()
      .from('users')
      .whereIn('id', [...ids])
    return (rows as UserRow[]).map(toUser)
  }

  async insert(user: NewUser) {
    const result = await conn().rawQuery(
      `insert into users (email, display_name, password_hash, status, email_verified_at, locale)
       values (?, ?, ?, ?, ?, ?)
       on conflict (email) do nothing
       returning *`,
      [
        user.email,
        user.displayName,
        user.passwordHash as string,
        user.status,
        user.emailVerifiedAt as Date,
        user.locale as string,
      ]
    )
    const [row] = result.rows as UserRow[]
    return row ? toUser(row) : null
  }

  async updatePasswordHash(userId: string, passwordHash: string) {
    await conn()
      .from('users')
      .where('id', userId)
      .update({ password_hash: passwordHash, updated_at: new Date() })
      .increment('version', 1)
  }
}

export class LucidSessionRepository implements SessionRepository {
  async insert(session: NewSession) {
    const [row] = await conn()
      .table('auth_sessions')
      .insert({
        user_id: session.userId,
        token_hash: session.tokenHash,
        expires_at: session.expiresAt,
        last_seen_at: session.now,
        ip: session.ip,
        user_agent: session.userAgent,
      })
      .returning('*')
    return toSession(row)
  }

  async findActiveByTokenHash(tokenHash: string, now: Date) {
    const row = await conn()
      .from('auth_sessions')
      .where('token_hash', tokenHash)
      .whereNull('revoked_at')
      .where('expires_at', '>', now)
      .first()
    return row ? toSession(row) : null
  }

  async listActiveByUser(userId: string, now: Date) {
    const rows = await conn()
      .from('auth_sessions')
      .where('user_id', userId)
      .whereNull('revoked_at')
      .where('expires_at', '>', now)
      .orderBy('created_at', 'desc')
    return (rows as SessionRow[]).map(toSession)
  }

  async touch(sessionId: string, now: Date) {
    await conn().from('auth_sessions').where('id', sessionId).update({ last_seen_at: now })
  }

  async revoke(userId: string, sessionId: string, now: Date) {
    const rows = await conn()
      .from('auth_sessions')
      .where({ id: sessionId, user_id: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: now, updated_at: now })
      .returning('id')
    return rows.length > 0
  }

  async revokeAllForUser(userId: string, now: Date, exceptSessionId?: string) {
    const query = conn()
      .from('auth_sessions')
      .where('user_id', userId)
      .whereNull('revoked_at')
      .update({ revoked_at: now, updated_at: now })
      .returning('id')
    if (exceptSessionId) query.whereNot('id', exceptSessionId)
    const revoked = await query
    return revoked.length
  }
}

export class LucidOneTimeTokenStore implements OneTimeTokenStore {
  async create(input: {
    userId: string
    purpose: TokenPurpose
    tokenHash: string
    expiresAt: Date
    now: Date
  }) {
    await conn().table('one_time_tokens').insert({
      user_id: input.userId,
      purpose: input.purpose,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
    })
  }

  async invalidateOpen(userId: string, purpose: TokenPurpose, now: Date) {
    await conn()
      .from('one_time_tokens')
      .where({ user_id: userId, purpose })
      .whereNull('consumed_at')
      .where('expires_at', '>', now)
      .update({ consumed_at: now, updated_at: now })
  }

  async findUsable(input: { tokenHash: string; purpose: TokenPurpose; now: Date }) {
    const row = await conn()
      .from('one_time_tokens')
      .where({ token_hash: input.tokenHash, purpose: input.purpose })
      .whereNull('consumed_at')
      .where('expires_at', '>', input.now)
      .first()
    return row ? { userId: row.user_id as string } : null
  }

  async completePasswordReset(input: { tokenHash: string; passwordHash: string; now: Date }) {
    return conn().transaction(async (trx) => {
      // O UPDATE condicional é o que garante o uso único: só uma transacção consegue consumir o token.
      const consumed = await trx
        .from('one_time_tokens')
        .where({ token_hash: input.tokenHash, purpose: 'RESET_PASSWORD' })
        .whereNull('consumed_at')
        .where('expires_at', '>', input.now)
        .update({ consumed_at: input.now, updated_at: input.now })
        .returning('user_id')
      if (consumed.length === 0) return null
      const userId = consumed[0].user_id as string

      await trx
        .from('users')
        .where('id', userId)
        .update({ password_hash: input.passwordHash, updated_at: input.now })
        .increment('version', 1)
      await trx
        .from('auth_sessions')
        .where('user_id', userId)
        .whereNull('revoked_at')
        .update({ revoked_at: input.now, updated_at: input.now })
      return { userId }
    })
  }

  async completeEmailVerification(input: { tokenHash: string; now: Date }) {
    return conn().transaction(async (trx) => {
      const consumed = await trx
        .from('one_time_tokens')
        .where({ token_hash: input.tokenHash, purpose: 'VERIFY_EMAIL' })
        .whereNull('consumed_at')
        .where('expires_at', '>', input.now)
        .update({ consumed_at: input.now, updated_at: input.now })
        .returning('user_id')
      if (consumed.length === 0) return null
      const userId = consumed[0].user_id as string

      // Só activa contas pendentes; uma conta BLOQUEADA continua bloqueada.
      await trx.rawQuery(
        `update users
            set email_verified_at = ?, updated_at = ?, version = version + 1,
                status = case when status = 'PENDING' then 'ACTIVE' else status end
          where id = ?`,
        [input.now, input.now, userId]
      )
      return { userId }
    })
  }
}
