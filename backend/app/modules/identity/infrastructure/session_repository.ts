import { createHash, randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'

/** Sessão inactiva expira ao fim de 8 h; nenhuma dura mais de 7 dias. */
export const IDLE_HOURS = 8
export const ABSOLUTE_DAYS = 7

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export interface SessionRecord {
  id: string
  userId: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  ip: string | null
  userAgent: string | null
}

const conn = () => db.connection('runtime')

/** Sessões opacas: o cliente guarda o token num cookie HttpOnly; a base só guarda o SHA-256 dele. */
export class SessionRepository {
  async create(userId: string, meta: { ip: string | null; userAgent: string | null }) {
    const token = randomBytes(32).toString('base64url')
    await conn().rawQuery(
      `insert into auth_sessions (user_id, token_hash, expires_at, last_seen_at, ip, user_agent)
       values (?, ?, now() + make_interval(hours => ?), now(), ?, ?)`,
      [
        userId,
        hashToken(token),
        IDLE_HOURS,
        meta.ip,
        meta.userAgent?.slice(0, 300) ?? null,
      ] as never[]
    )
    return token
  }

  /** Sessão válida para o token, renovando a janela de inactividade (no máximo uma escrita por minuto). */
  async resolve(token: string): Promise<SessionRecord | null> {
    const result = await conn().rawQuery(
      `update auth_sessions
          set last_seen_at = now(),
              expires_at = least(now() + make_interval(hours => ?), created_at + make_interval(days => ?))
        where token_hash = ? and revoked_at is null and expires_at > now()
          and created_at > now() - make_interval(days => ?)
          and last_seen_at < now() - interval '1 minute'
        returning id, user_id, created_at, last_seen_at, expires_at, ip, user_agent`,
      [IDLE_HOURS, ABSOLUTE_DAYS, hashToken(token), ABSOLUTE_DAYS]
    )
    const rows =
      result.rows.length > 0
        ? result.rows
        : (
            await conn().rawQuery(
              `select id, user_id, created_at, last_seen_at, expires_at, ip, user_agent from auth_sessions
                where token_hash = ? and revoked_at is null and expires_at > now()
                  and created_at > now() - make_interval(days => ?)`,
              [hashToken(token), ABSOLUTE_DAYS]
            )
          ).rows
    const [row] = rows as {
      id: string
      user_id: string
      created_at: Date
      last_seen_at: Date
      expires_at: Date
      ip: string | null
      user_agent: string | null
    }[]
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          expiresAt: row.expires_at,
          ip: row.ip,
          userAgent: row.user_agent,
        }
      : null
  }

  async revoke(token: string) {
    await conn().rawQuery(
      'update auth_sessions set revoked_at = now() where token_hash = ? and revoked_at is null',
      [hashToken(token)]
    )
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string) {
    await conn().rawQuery(
      'update auth_sessions set revoked_at = now() where user_id = ? and revoked_at is null and id <> coalesce(?::uuid, id)',
      [userId, exceptSessionId ?? null] as never[]
    )
  }
}
