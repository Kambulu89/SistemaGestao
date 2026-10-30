import { ApiError, type ApiErrorDetail } from '#core/http/api_error'
import { isValidEmail, normalizeEmail } from '#core/auth/domain/email'
import { PASSWORD_ISSUE_MESSAGES, passwordIssues } from '#core/auth/domain/password_policy'
import { TOKEN_TTL_SECONDS, type Principal, type User } from '#core/auth/domain/identity'
import { generateOpaqueToken, hashToken } from '#core/auth/domain/tokens'
import type {
  Clock,
  OneTimeTokenStore,
  PasswordHasher,
  RateLimiter,
  SessionRepository,
  TokenMailer,
  UserRepository,
} from '#core/auth/application/ports'

const WINDOW_15_MIN = 15 * 60
const WINDOW_1_HOUR = 60 * 60

export const invalidToken = () =>
  new ApiError(400, 'INVALID_OR_EXPIRED_TOKEN', 'A ligação é inválida ou expirou.')

function assertPasswordPolicy(password: string, email?: string, path = 'password') {
  const issues = passwordIssues(password, { email })
  if (issues.length > 0) {
    const details: ApiErrorDetail[] = issues.map((code) => ({
      path,
      code,
      message: PASSWORD_ISSUE_MESSAGES[code],
    }))
    throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)
  }
}

/** Alteração de palavra-passe com reautenticação; revoga as outras sessões. */
export class ChangePassword {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock
  ) {}

  async execute(
    principal: Principal,
    input: { currentPassword: string; newPassword: string }
  ): Promise<void> {
    const attempt = await this.limiter.hit(`pwd:${principal.user.id}`, 5, WINDOW_15_MIN)
    if (!attempt.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Demasiadas tentativas. Tente mais tarde.', [], {
        'retry-after': String(Math.max(1, attempt.retryAfterSeconds)),
      })
    }

    const hash = principal.user.passwordHash
    if (!hash || !(await this.hasher.verify(hash, input.currentPassword))) {
      throw new ApiError(
        403,
        'REAUTHENTICATION_FAILED',
        'A palavra-passe actual não está correcta.'
      )
    }
    assertPasswordPolicy(input.newPassword, principal.user.email, 'newPassword')

    await this.users.updatePasswordHash(
      principal.user.id,
      await this.hasher.hash(input.newPassword)
    )
    await this.sessions.revokeAllForUser(principal.user.id, this.clock.now(), principal.session.id)
    await this.limiter.reset(`pwd:${principal.user.id}`)
  }
}

/**
 * Pedido de recuperação. Responde sempre da mesma forma, exista ou não a conta (não revela emails).
 * A ligação só é enviada a contas activas; um pedido novo invalida o anterior.
 */
export class RequestPasswordReset {
  constructor(
    private readonly users: UserRepository,
    private readonly tokens: OneTimeTokenStore,
    private readonly mailer: TokenMailer,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    private readonly hashEmailForKey: (email: string) => string
  ) {}

  async execute(input: { email: string; ip: string | null }): Promise<void> {
    const email = normalizeEmail(input.email)
    const byIp = await this.limiter.hit(`reset:ip:${input.ip ?? 'unknown'}`, 10, WINDOW_1_HOUR)
    if (!byIp.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Demasiadas tentativas. Tente mais tarde.', [], {
        'retry-after': String(Math.max(1, byIp.retryAfterSeconds)),
      })
    }
    // Por conta: o excesso é ignorado em silêncio (para não revelar nada nem permitir inundar a caixa).
    const byAccount = await this.limiter.hit(
      `reset:acct:${this.hashEmailForKey(email)}`,
      3,
      WINDOW_1_HOUR
    )
    if (!byAccount.allowed) return

    const user = await this.users.findByEmail(email)
    if (!user || user.status !== 'ACTIVE') return

    const now = this.clock.now()
    const token = generateOpaqueToken()
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_SECONDS.RESET_PASSWORD * 1000)
    await this.tokens.invalidateOpen(user.id, 'RESET_PASSWORD', now)
    await this.tokens.create({
      userId: user.id,
      purpose: 'RESET_PASSWORD',
      tokenHash: hashToken(token),
      expiresAt,
      now,
    })
    await this.mailer.send({ to: user.email, purpose: 'RESET_PASSWORD', token, expiresAt })
  }
}

/** Conclui a recuperação: token de uso único; revoga todas as sessões. */
export class ResetPassword {
  constructor(
    private readonly users: UserRepository,
    private readonly tokens: OneTimeTokenStore,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock
  ) {}

  async execute(input: { token: string; newPassword: string }): Promise<void> {
    const now = this.clock.now()
    const tokenHash = hashToken(input.token)
    const owner = await this.tokens.findUsable({ tokenHash, purpose: 'RESET_PASSWORD', now })
    if (!owner) throw invalidToken()

    const user = await this.users.findById(owner.userId)
    assertPasswordPolicy(input.newPassword, user?.email, 'newPassword')

    const result = await this.tokens.completePasswordReset({
      tokenHash,
      passwordHash: await this.hasher.hash(input.newPassword),
      now,
    })
    // Perdeu a corrida: outro pedido consumiu o mesmo token entretanto.
    if (!result) throw invalidToken()
  }
}

/** Criação de conta (operações internas e, mais tarde, aceitação de convites). */
export class CreateUser {
  constructor(
    private readonly users: UserRepository,
    private readonly tokens: OneTimeTokenStore,
    private readonly hasher: PasswordHasher,
    private readonly mailer: TokenMailer,
    private readonly clock: Clock
  ) {}

  async execute(input: {
    email: string
    displayName: string
    password?: string
    /** Conta já verificada e activa (seeds e operações internas). Caso contrário fica pendente até verificar o email. */
    verified?: boolean
    locale?: string | null
  }): Promise<User> {
    const email = normalizeEmail(input.email)
    const details: ApiErrorDetail[] = []
    if (!isValidEmail(email)) {
      details.push({ path: 'email', code: 'INVALID_EMAIL', message: 'O email não é válido.' })
    }
    if (!input.displayName.trim() || input.displayName.length > 160) {
      details.push({
        path: 'displayName',
        code: 'INVALID_NAME',
        message: 'O nome é obrigatório (máx. 160).',
      })
    }
    if (details.length > 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)
    }
    if (input.password !== undefined) assertPasswordPolicy(input.password, email)
    if (input.verified && input.password === undefined) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Uma conta activa precisa de palavra-passe.', [
        { path: 'password', code: 'REQUIRED', message: 'Indique a palavra-passe.' },
      ])
    }

    const now = this.clock.now()
    const user = await this.users.insert({
      email,
      displayName: input.displayName.trim(),
      passwordHash: input.password === undefined ? null : await this.hasher.hash(input.password),
      status: input.verified ? 'ACTIVE' : 'PENDING',
      emailVerifiedAt: input.verified ? now : null,
      locale: input.locale ?? null,
    })
    if (!user)
      throw ApiError.conflict('EMAIL_ALREADY_REGISTERED', 'Já existe uma conta com este email.')

    if (!input.verified) {
      const token = generateOpaqueToken()
      const expiresAt = new Date(now.getTime() + TOKEN_TTL_SECONDS.VERIFY_EMAIL * 1000)
      await this.tokens.create({
        userId: user.id,
        purpose: 'VERIFY_EMAIL',
        tokenHash: hashToken(token),
        expiresAt,
        now,
      })
      await this.mailer.send({ to: user.email, purpose: 'VERIFY_EMAIL', token, expiresAt })
    }
    return user
  }
}

/** Verificação do email por token de uso único; activa a conta pendente. */
export class VerifyEmail {
  constructor(
    private readonly tokens: OneTimeTokenStore,
    private readonly clock: Clock
  ) {}

  async execute(token: string): Promise<void> {
    const result = await this.tokens.completeEmailVerification({
      tokenHash: hashToken(token),
      now: this.clock.now(),
    })
    if (!result) throw invalidToken()
  }
}
