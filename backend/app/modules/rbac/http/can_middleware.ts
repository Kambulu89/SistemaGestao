import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ApiError } from '#shared/http/api_error'
import { permissionsFor } from '#modules/rbac/application/authorization'

/** `middleware.can({ permission })`: exige a permissão com âmbito de empresa (negar por omissão). */
export default class CanMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { permission: string }) {
    if (!ctx.tenantContext) throw ApiError.forbidden()
    const granted = await permissionsFor(ctx.tenantContext)
    if (!granted.tenant.has(options.permission)) throw ApiError.forbidden()
    return next()
  }
}
