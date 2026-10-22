import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import corsConfig from '#config/cors'
import { ApiError } from '#core/http/api_error'
import type { Principal } from '#core/auth/domain/identity'
import { CSRF_HEADER, SESSION_COOKIE, authServices } from '#core/auth/presentation/composition'

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /** Utilizador e sessão autenticados (só nas rotas com o middleware `auth`). */
    principal: Principal
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Rejeita pedidos de escrita cuja origem de browser não esteja na lista permitida (defesa em
 * profundidade contra CSRF e "login CSRF"). Clientes sem `Origin` (não-browser) passam; nas rotas
 * autenticadas o token CSRF continua a ser exigido.
 */
export class OriginMiddleware {
  private readonly allowed = new Set(
    (Array.isArray(corsConfig.origin) ? corsConfig.origin : []) as string[]
  )

  async handle({ request }: HttpContext, next: NextFn) {
    if (!SAFE_METHODS.has(request.method())) {
      const origin = request.header('origin')
      if (origin && !this.allowed.has(origin)) {
        throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origem do pedido não permitida.')
      }
    }
    return next()
  }
}

/** Exige sessão válida (cookie opaco) e, nos métodos de escrita, o token CSRF da sessão. */
export default class AuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const services = authServices()
    const principal = await services.authenticate.execute(ctx.request.plainCookie(SESSION_COOKIE))
    if (!principal) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada.')
    }

    if (!SAFE_METHODS.has(ctx.request.method())) {
      if (!services.csrf.verify(principal.session.id, ctx.request.header(CSRF_HEADER))) {
        throw new ApiError(403, 'CSRF_TOKEN_INVALID', 'Token CSRF em falta ou inválido.')
      }
    }

    ctx.principal = principal
    ctx.logger = ctx.logger.child({ userId: principal.user.id, sessionId: principal.session.id })
    return next()
  }
}
