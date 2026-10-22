import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { appKey } from '#config/app'
import { generateOpaqueToken } from '#core/auth/domain/tokens'
import {
  ChangePassword,
  CreateUser,
  RequestPasswordReset,
  ResetPassword,
  VerifyEmail,
} from '#core/auth/application/password_use_cases'
import {
  AuthenticateSession,
  ListSessions,
  LoginUser,
  LogoutSession,
  RevokeSession,
} from '#core/auth/application/session_use_cases'
import { HmacCsrfTokens, emailKeyHasher } from '#core/auth/infrastructure/hmac_csrf_tokens'
import {
  LucidOneTimeTokenStore,
  LucidSessionRepository,
  LucidUserRepository,
} from '#core/auth/infrastructure/lucid_identity_repositories'
import { RedisRateLimiter } from '#core/auth/infrastructure/redis_rate_limiter'
import { ScryptPasswordHasher } from '#core/auth/infrastructure/scrypt_password_hasher'
import { SystemClock } from '#core/auth/infrastructure/system_clock'
import { DevRedisTokenMailer, NoopTokenMailer } from '#core/auth/infrastructure/token_mailers'

/** Nome do cookie: em produção usa o prefixo `__Host-` (Secure, Path=/, sem Domain). */
export const SESSION_COOKIE = app.inProduction ? '__Host-sg_session' : 'sg_session'

export const CSRF_HEADER = 'x-csrf-token'

export function buildAuthServices() {
  const secret = appKey.release()
  const users = new LucidUserRepository()
  const sessions = new LucidSessionRepository()
  const tokens = new LucidOneTimeTokenStore()
  const hasher = new ScryptPasswordHasher()
  const limiter = new RedisRateLimiter()
  const clock = new SystemClock()
  const mailer =
    env.get('MAIL_DRIVER') === 'dev-redis' ? new DevRedisTokenMailer() : new NoopTokenMailer()
  const hashEmail = emailKeyHasher(secret)

  return {
    csrf: new HmacCsrfTokens(secret),
    users,
    createUser: new CreateUser(users, tokens, hasher, mailer, clock),
    authenticate: new AuthenticateSession(users, sessions, clock),
    logout: new LogoutSession(sessions, clock),
    listSessions: new ListSessions(sessions, clock),
    revokeSession: new RevokeSession(sessions, clock),
    changePassword: new ChangePassword(users, sessions, hasher, limiter, clock),
    requestPasswordReset: new RequestPasswordReset(
      users,
      tokens,
      mailer,
      limiter,
      clock,
      hashEmail
    ),
    resetPassword: new ResetPassword(users, tokens, hasher, clock),
    verifyEmail: new VerifyEmail(tokens, clock),
    /** Criado de forma assíncrona porque o scrypt é caro; ver `loginUser()`. */
    loginPromise: hasher
      .hash(generateOpaqueToken())
      .then(
        (dummyHash) => new LoginUser(users, sessions, hasher, limiter, clock, dummyHash, hashEmail)
      ),
  }
}

export type AuthServices = ReturnType<typeof buildAuthServices>

let instance: AuthServices | undefined

/** Composição preguiçosa: só liga ao Redis/base quando há o primeiro pedido. */
export function authServices(): AuthServices {
  instance ??= buildAuthServices()
  return instance
}
