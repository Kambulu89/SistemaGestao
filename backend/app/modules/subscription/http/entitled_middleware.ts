import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ApiError } from '#shared/http/api_error'
import { assertEntitled } from '#modules/subscription/application/entitlements'

/** `middleware.entitled({ feature })`: a empresa tem de ter a funcionalidade contratada (independente do RBAC). */
export default class EntitledMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { feature: string }) {
    if (!ctx.tenantContext) throw ApiError.forbidden()
    await assertEntitled(ctx.tenantContext.tenantId, options.feature)
    return next()
  }
}
