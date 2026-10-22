import type { AuthSession, TokenPurpose, User } from '#core/auth/domain/identity'

export interface Clock {
  now(): Date
}

export interface NewUser {
  email: string
  displayName: string
  passwordHash: string | null
  status: 'PENDING' | 'ACTIVE'
  emailVerifiedAt: Date | null
  locale: string | null
}

export interface UserRepository {
  findByEmail(normalizedEmail: string): Promise<User | null>
  findById(id: string): Promise<User | null>
  findByIds(ids: readonly string[]): Promise<User[]>
  /** Devolve `null` se o email já existir (a unicidade é decidida pela base, não por uma consulta prévia). */
  insert(user: NewUser): Promise<User | null>
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>
}

export interface NewSession {
  userId: string
  tokenHash: string
  expiresAt: Date
  ip: string | null
  userAgent: string | null
  now: Date
}

export interface SessionRepository {
  insert(session: NewSession): Promise<AuthSession>
  findActiveByTokenHash(tokenHash: string, now: Date): Promise<AuthSession | null>
  listActiveByUser(userId: string, now: Date): Promise<AuthSession[]>
  touch(sessionId: string, now: Date): Promise<void>
  /** Revoga uma sessão do utilizador. `false` se não existir, for de outro utilizador ou já estiver revogada. */
  revoke(userId: string, sessionId: string, now: Date): Promise<boolean>
  revokeAllForUser(userId: string, now: Date, exceptSessionId?: string): Promise<number>
}

export interface TokenRecord {
  id: string
  userId: string
  purpose: TokenPurpose
}

export interface OneTimeTokenStore {
  create(input: {
    userId: string
    purpose: TokenPurpose
    tokenHash: string
    expiresAt: Date
    now: Date
  }): Promise<void>
  /** Inutiliza os tokens ainda válidos do mesmo fim (um pedido novo invalida o anterior). */
  invalidateOpen(userId: string, purpose: TokenPurpose, now: Date): Promise<void>
  /** O dono de um token ainda utilizável (não consumido nem expirado), sem o consumir. */
  findUsable(input: {
    tokenHash: string
    purpose: TokenPurpose
    now: Date
  }): Promise<{ userId: string } | null>
  /**
   * Conclui a recuperação **numa única transacção**: consome o token (uso único, mesmo sob concorrência),
   * define a nova palavra-passe e revoga todas as sessões. `null` se o token for inválido, expirado ou usado.
   */
  completePasswordReset(input: {
    tokenHash: string
    passwordHash: string
    now: Date
  }): Promise<{ userId: string } | null>
  /** Consome o token e marca o email como verificado (e activa a conta pendente). */
  completeEmailVerification(input: {
    tokenHash: string
    now: Date
  }): Promise<{ userId: string } | null>
}

export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(hash: string, password: string): Promise<boolean>
  needsRehash(hash: string): boolean
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

export interface RateLimiter {
  /** Regista uma tentativa na janela e diz se ainda é permitida. */
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>
  reset(key: string): Promise<void>
}

export interface TokenMessage {
  to: string
  /** `INVITATION`: convite para um tenant (o token é gerido pelo módulo de membros). */
  purpose: TokenPurpose | 'INVITATION'
  token: string
  expiresAt: Date
}

/** Porta de entrega de tokens (email). O fornecedor real é uma decisão de produto pendente. */
export interface TokenMailer {
  send(message: TokenMessage): Promise<void>
}

/** Token anti-CSRF derivado da sessão: só quem conhece a sessão o pode obter. */
export interface CsrfTokens {
  issue(sessionId: string): string
  verify(sessionId: string, token: string | undefined): boolean
}
