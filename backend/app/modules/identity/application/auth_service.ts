import hash from '@adonisjs/core/services/hash'
import { ApiError } from '#shared/http/api_error'
import { normalizeEmail, type User } from '#modules/identity/domain/user'
import { UserRepository } from '#modules/identity/infrastructure/user_repository'
import { SessionRepository } from '#modules/identity/infrastructure/session_repository'
import { hitRateLimit, resetRateLimit } from '#modules/identity/infrastructure/rate_limiter'
import { hmac } from '#modules/identity/infrastructure/secrets'

/** Usado quando o email não existe, para o tempo de resposta não revelar se a conta existe. */
let dummyHash: string | undefined

export interface LoginResult {
  user: User
  sessionToken: string
}

/** Entrada e saída de sessão. Mensagens genéricas: nunca dizem se o email existe. */
export class AuthService {
  constructor(
    private readonly users = new UserRepository(),
    private readonly sessions = new SessionRepository()
  ) {}

  async login(
    input: { email: unknown; password: unknown },
    meta: { ip: string | null; userAgent: string | null }
  ): Promise<LoginResult> {
    const email = normalizeEmail(input.email)
    const password = typeof input.password === 'string' ? input.password : ''
    const ipLimit = await hitRateLimit(`login:ip:${hmac('ip', meta.ip ?? '-')}`, 100, 900)
    if (!ipLimit.allowed) throw ApiError.tooManyRequests(ipLimit.retryAfterSeconds)
    const emailKey = `login:email:${hmac('email', email ?? '-')}`
    const emailLimit = await hitRateLimit(emailKey, 10, 900)
    if (!emailLimit.allowed) throw ApiError.tooManyRequests(emailLimit.retryAfterSeconds)

    const found = email ? await this.users.credentials(email) : null
    dummyHash ??= await hash.make('palavra-passe-ficticia-para-tempo-constante')
    const valid = await hash.verify(found?.passwordHash ?? dummyHash, password)
    if (!found || !found.passwordHash || !valid || found.user.status !== 'ACTIVE') {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email ou palavra-passe incorrectos.')
    }
    await resetRateLimit(emailKey)
    await this.users.touchLogin(found.user.id)
    const sessionToken = await this.sessions.create(found.user.id, meta)
    return { user: found.user, sessionToken }
  }

  logout(sessionToken: string) {
    return this.sessions.revoke(sessionToken)
  }

  /** Utilizador da sessão, se a sessão é válida e a conta está activa. */
  async resolve(sessionToken: string): Promise<{ user: User; sessionId: string } | null> {
    const session = await this.sessions.resolve(sessionToken)
    if (!session) return null
    const user = await this.users.find(session.userId)
    if (!user || user.status !== 'ACTIVE') return null
    return { user, sessionId: session.id }
  }
}
