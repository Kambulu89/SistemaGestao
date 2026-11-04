import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ApiError } from '#shared/http/api_error'
import { AuthService } from '#modules/identity/application/auth_service'
import { readSessionToken, XSRF_HEADER } from '#modules/identity/http/cookies'
import { csrfTokenFor, safeEqual } from '#modules/identity/infrastructure/secrets'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const auth = new AuthService()

/**
 * Exige sessão válida (cookie HttpOnly) e, nos métodos que alteram dados, o token CSRF de dupla submissão
 * (`X-XSRF-TOKEN` = HMAC da sessão). Coloca o utilizador em `ctx.authUser`.
 */
export default class AuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const token = readSessionToken(ctx)
    const resolved = token ? await auth.resolve(token) : null
    if (!token || !resolved) throw ApiError.unauthenticated()
    if (!SAFE_METHODS.has(ctx.request.method())) {
      const header = ctx.request.header(XSRF_HEADER) ?? ''
      if (!safeEqual(header, csrfTokenFor(token))) {
        throw ApiError.forbidden('CSRF_INVALID', 'Pedido sem token CSRF válido.')
      }
    }
    ctx.authUser = resolved.user
    ctx.sessionId = resolved.sessionId
    return next()
  }
}
