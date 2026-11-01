import { createHmac } from 'node:crypto'
import { safeEqual } from '#core/auth/domain/tokens'
import type { CsrfTokens } from '#core/auth/application/ports'

/** CSRF = HMAC(APP_KEY, sessionId): só quem tem sessão válida o obtém, e muda com cada sessão. */
export class HmacCsrfTokens implements CsrfTokens {
  constructor(private readonly secret: string) {}

  issue(sessionId: string) {
    return createHmac('sha256', this.secret).update(`csrf:${sessionId}`).digest('base64url')
  }

  verify(sessionId: string, token: string | undefined) {
    return !!token && safeEqual(this.issue(sessionId), token)
  }
}

/** Chave de rate limit para um email: o endereço nunca aparece em chaves do Redis nem em logs. */
export const emailKeyHasher = (secret: string) => (email: string) =>
  createHmac('sha256', secret).update(`email:${email}`).digest('hex').slice(0, 32)
