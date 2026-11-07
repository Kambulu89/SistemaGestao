import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ApiError } from '#shared/http/api_error'

/**
 * Rotas `/platform/*`: só administradores da plataforma (`users.is_platform_admin`). Gerem o plano de controlo (tenants,
 * planos, subscrições); **não** dão acesso aos dados de negócio dos tenants.
 */
export default class PlatformAdminMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!ctx.authUser?.isPlatformAdmin) {
      throw ApiError.forbidden(
        'PLATFORM_ADMIN_REQUIRED',
        'Reservado à administração da plataforma.'
      )
    }
    return next()
  }
}
