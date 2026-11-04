import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import env from '#start/env'
import { ApiError } from '#shared/http/api_error'
import { normalizeEmail, passwordIssues, type User } from '#modules/identity/domain/user'
import { UserRepository } from '#modules/identity/infrastructure/user_repository'
import { TokenRepository } from '#modules/identity/infrastructure/token_repository'
import { sendMail, type DeliveryStatus } from '#modules/identity/infrastructure/mailer'
import { hitRateLimit } from '#modules/identity/infrastructure/rate_limiter'
import { hmac } from '#modules/identity/infrastructure/secrets'

const RESET_TTL_MINUTES = 60
const users = new UserRepository()
const tokens = new TokenRepository()

const frontendUrl = () => (env.get('APP_URL') ?? '').replace(/\/$/, '')

/** Conta global: recuperação de palavra-passe, sessões e criação de contas para convites. */
export class AccountService {
  /** Resposta sempre genérica: não revela se o email existe. */
  async requestPasswordReset(rawEmail: unknown): Promise<void> {
    const email = normalizeEmail(rawEmail)
    const limit = await hitRateLimit(`reset:${hmac('email', email ?? '-')}`, 5, 3600)
    if (!limit.allowed || !email) return
    const user = await users.findByEmail(email)
    if (!user || user.status !== 'ACTIVE') return
    const token = await tokens.issue({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      ttlMinutes: RESET_TTL_MINUTES,
    })
    await sendMail({
      to: user.email,
      purpose: 'PASSWORD_RESET',
      subject: 'Recuperação da palavra-passe',
      link: `${frontendUrl()}/redefinir-palavra-passe?token=${encodeURIComponent(token)}`,
    })
  }

  /** Define a nova palavra-passe, consome o token e termina todas as sessões da conta. */
  async resetPassword(token: unknown, password: unknown): Promise<void> {
    const issues = passwordIssues(password)
    if (issues.length > 0) throw ApiError.validation(issues)
    const passwordHash = await hash.make(password as string)
    await db.connection('runtime').transaction(async (trx) => {
      const consumed =
        typeof token === 'string' ? await tokens.consume(trx, token, 'PASSWORD_RESET') : null
      if (!consumed)
        throw ApiError.badRequest('TOKEN_INVALID', 'Ligação inválida, expirada ou já utilizada.')
      await trx.rawQuery(
        'update users set password_hash = ?, version = version + 1, updated_at = now() where id = ?',
        [passwordHash, consumed.userId]
      )
      await trx.rawQuery(
        'update auth_sessions set revoked_at = now() where user_id = ? and revoked_at is null',
        [consumed.userId]
      )
    })
  }

  listSessions(userId: string) {
    return db
      .connection('runtime')
      .rawQuery(
        `select id, created_at, last_seen_at, expires_at, ip, user_agent from auth_sessions
          where user_id = ? and revoked_at is null and expires_at > now() order by last_seen_at desc`,
        [userId]
      )
      .then((r) =>
        (
          r.rows as {
            id: string
            created_at: Date
            last_seen_at: Date
            expires_at: Date
            ip: string | null
            user_agent: string | null
          }[]
        ).map((s) => ({
          id: s.id,
          createdAt: s.created_at,
          lastSeenAt: s.last_seen_at,
          expiresAt: s.expires_at,
          ip: s.ip,
          userAgent: s.user_agent,
        }))
      )
  }

  async revokeSession(userId: string, sessionId: string) {
    const result = await db
      .connection('runtime')
      .rawQuery(
        'update auth_sessions set revoked_at = now() where id = ? and user_id = ? and revoked_at is null returning id',
        [sessionId, userId]
      )
    if (result.rows.length === 0) throw ApiError.notFound()
  }

  /** Conta para um convite: existente (pelo email) ou nova, sem palavra-passe até aceitar o convite. */
  async findOrCreateForInvitation(rawEmail: unknown, fullName: unknown): Promise<User> {
    const email = normalizeEmail(rawEmail)
    if (!email)
      throw ApiError.validation([
        { path: 'email', code: 'INVALID_EMAIL', message: 'Email inválido.' },
      ])
    const existing = await users.findByEmail(email)
    if (existing) return existing
    const name =
      typeof fullName === 'string' && fullName.trim() ? fullName.trim().slice(0, 160) : email
    return users.insert({ email, fullName: name, passwordHash: null })
  }

  async issueInvitation(
    user: User,
    tenantId: string,
    membershipId: string,
    tenantName: string
  ): Promise<DeliveryStatus> {
    const token = await tokens.issue({
      userId: user.id,
      purpose: 'INVITATION',
      ttlMinutes: 7 * 24 * 60,
      tenantId,
      membershipId,
    })
    return sendMail({
      to: user.email,
      purpose: 'INVITATION',
      subject: `Convite para ${tenantName}`,
      link: `${frontendUrl()}/aceitar-convite?token=${encodeURIComponent(token)}`,
    })
  }

  /**
   * Consome o convite e, na **mesma** transacção, chama `activate` (que activa a membership): se a activação falhar, o
   * token não fica gasto. Se a conta ainda não tem palavra-passe, exige-a e define-a.
   */
  async consumeInvitation(
    token: unknown,
    password: unknown,
    fullName: unknown,
    activate: (
      trx: TransactionClientContract,
      invitation: { userId: string; tenantId: string; membershipId: string }
    ) => Promise<void>
  ) {
    return db.connection('runtime').transaction(async (trx) => {
      const consumed =
        typeof token === 'string' ? await tokens.consume(trx, token, 'INVITATION') : null
      if (!consumed || !consumed.tenantId || !consumed.membershipId) {
        throw ApiError.badRequest('TOKEN_INVALID', 'Convite inválido, expirado ou já utilizado.')
      }
      const result = await trx.rawQuery('select password_hash from users where id = ? for update', [
        consumed.userId,
      ])
      const hasPassword = Boolean(
        (result.rows[0] as { password_hash: string | null }).password_hash
      )
      if (!hasPassword) {
        const issues = passwordIssues(password)
        if (issues.length > 0) throw ApiError.validation(issues)
        const name =
          typeof fullName === 'string' && fullName.trim() ? fullName.trim().slice(0, 160) : null
        await trx.rawQuery(
          'update users set password_hash = ?, full_name = coalesce(?, full_name), version = version + 1, updated_at = now() where id = ?',
          [await hash.make(password as string), name, consumed.userId] as never[]
        )
      }
      const invitation = {
        userId: consumed.userId,
        tenantId: consumed.tenantId,
        membershipId: consumed.membershipId,
      }
      await activate(trx, invitation)
      return invitation
    })
  }
}
