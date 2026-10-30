import { ApiError } from '#core/http/api_error'
import { normalizeEmail } from '#core/auth/domain/email'
import {
  type AuthSession,
  type Principal,
  SESSION_TOUCH_INTERVAL_SECONDS,
  SESSION_TTL_SECONDS,
  type User,
  canLogin,
} from '#core/auth/domain/identity'
import { generateOpaqueToken, hashToken } from '#core/auth/domain/tokens'
import type {
  Clock,
  PasswordHasher,
  RateLimiter,
  SessionRepository,
  UserRepository,
} from '#core/auth/application/ports'

const LOGIN_WINDOW_SECONDS = 15 * 60
const LOGIN_PER_ACCOUNT = 5
const LOGIN_PER_IP = 20

export interface LoginInput {
  email: string
  password: string
  ip: string | null
  userAgent: string | null
}

export interface LoginResult {
  user: User
  session: AuthSession
  /** O token opaco: devolvido uma única vez, para o cookie. Nunca é guardado em claro. */
  sessionToken: string
}

const invalidCredentials = () =>
  new ApiError(401, 'INVALID_CREDENTIALS', 'Email ou palavra-passe inválidos.')

const rateLimited = (retryAfterSeconds: number) =>
  new ApiError(429, 'RATE_LIMITED', 'Demasiadas tentativas. Tente mais tarde.', [], {
    'retry-after': String(Math.max(1, retryAfterSeconds)),
  })

/** Início de sessão. As falhas (utilizador inexistente, palavra-passe errada, conta bloqueada) são indistinguíveis. */
export class LoginUser {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    /** Hash de uma palavra-passe aleatória: gasta o mesmo tempo quando o utilizador não existe. */
    private readonly dummyHash: string,
    private readonly hashEmailForKey: (email: string) => string
  ) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    const email = normalizeEmail(input.email)
    const ip = input.ip ?? 'unknown'
    const accountKey = `login:acct:${this.hashEmailForKey(email)}:${ip}`

    const perIp = await this.limiter.hit(`login:ip:${ip}`, LOGIN_PER_IP, LOGIN_WINDOW_SECONDS)
    const perAccount = await this.limiter.hit(accountKey, LOGIN_PER_ACCOUNT, LOGIN_WINDOW_SECONDS)
    if (!perIp.allowed || !perAccount.allowed) {
      throw rateLimited(Math.max(perIp.retryAfterSeconds, perAccount.retryAfterSeconds))
    }

    const user = await this.users.findByEmail(email)
    const hash = user?.passwordHash ?? this.dummyHash
    const passwordOk = await this.hasher.verify(hash, input.password)
    if (!user || !passwordOk || !canLogin(user)) throw invalidCredentials()

    await this.limiter.reset(accountKey)
    if (this.hasher.needsRehash(hash)) {
      await this.users.updatePasswordHash(user.id, await this.hasher.hash(input.password))
    }

    const now = this.clock.now()
    const sessionToken = generateOpaqueToken()
    const session = await this.sessions.insert({
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
      ip: input.ip?.slice(0, 64) ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      now,
    })
    return { user, session, sessionToken }
  }
}

/** Resolve o token do cookie para o utilizador e a sessão, ou `null`. Nunca revela porquê. */
export class AuthenticateSession {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly clock: Clock
  ) {}

  async execute(token: string | undefined): Promise<Principal | null> {
    if (!token) return null
    const now = this.clock.now()
    const session = await this.sessions.findActiveByTokenHash(hashToken(token), now)
    if (!session) return null
    const user = await this.users.findById(session.userId)
    if (!user || user.status !== 'ACTIVE') return null

    if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_SECONDS * 1000) {
      await this.sessions.touch(session.id, now)
    }
    return { user, session }
  }
}

export class LogoutSession {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock
  ) {}

  async execute(principal: Principal): Promise<void> {
    await this.sessions.revoke(principal.user.id, principal.session.id, this.clock.now())
  }
}

export interface SessionView {
  id: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  ip: string | null
  userAgent: string | null
  current: boolean
}

export class ListSessions {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock
  ) {}

  async execute(principal: Principal): Promise<SessionView[]> {
    const active = await this.sessions.listActiveByUser(principal.user.id, this.clock.now())
    return active.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.id === principal.session.id,
    }))
  }
}

export class RevokeSession {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock
  ) {}

  /** Só se revogam sessões do próprio utilizador; qualquer outra é 404 (não revela que existe). */
  async execute(principal: Principal, sessionId: string): Promise<void> {
    const revoked = await this.sessions.revoke(principal.user.id, sessionId, this.clock.now())
    if (!revoked) throw ApiError.notFound('Sessão não encontrada.')
  }
}
