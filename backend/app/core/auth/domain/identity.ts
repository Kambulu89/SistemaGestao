export type UserStatus = 'PENDING' | 'ACTIVE' | 'BLOCKED'
export type TokenPurpose = 'VERIFY_EMAIL' | 'RESET_PASSWORD'

export interface User {
  id: string
  email: string
  displayName: string
  passwordHash: string | null
  emailVerifiedAt: Date | null
  status: UserStatus
  locale: string | null
}

/** Só uma conta activa (email verificado) com palavra-passe pode iniciar sessão. */
export const canLogin = (user: User): boolean => user.status === 'ACTIVE' && !!user.passwordHash

export interface AuthSession {
  id: string
  userId: string
  expiresAt: Date
  revokedAt: Date | null
  lastSeenAt: Date
  createdAt: Date
  ip: string | null
  userAgent: string | null
}

export const isSessionActive = (session: AuthSession, now: Date): boolean =>
  session.revokedAt === null && session.expiresAt.getTime() > now.getTime()

/** Parâmetros de demonstração (validar com o produto): validade das sessões e dos tokens. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60
export const SESSION_TOUCH_INTERVAL_SECONDS = 60
export const TOKEN_TTL_SECONDS: Record<TokenPurpose, number> = {
  RESET_PASSWORD: 60 * 60,
  VERIFY_EMAIL: 24 * 60 * 60,
}

export interface Principal {
  user: User
  session: AuthSession
}
