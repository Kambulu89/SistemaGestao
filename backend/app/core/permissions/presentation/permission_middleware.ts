import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { securityEvents } from '#core/audit/index'
import { ApiError } from '#core/http/api_error'
import { iamServices } from '#core/permissions/presentation/composition'

/**
 * Exige uma permissão (RBAC + ABAC) para a rota, depois de `auth` e `tenant`. É a verificação
 * **no servidor**; guards e menus do frontend são só conveniência. Recursos concretos (com
 * atributos) voltam a ser verificados pelo caso de uso, com os atributos do registo.
 */
export default class PermissionMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { permission: string }) {
    let decision
    try {
      decision = await iamServices().authorize.require(ctx.tenantContext, options.permission)
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        await securityEvents.record({
          type: 'PERMISSION_DENIED',
          severity: 'WARN',
          tenantId: ctx.tenantContext.tenantId,
          userId: ctx.tenantContext.userId,
          metadata: { permission: options.permission, method: ctx.request.method() },
        })
      }
      throw error
    }
    ctx.logger.debug({ permission: options.permission, reason: decision.reason }, 'autorizado')
    return next()
  }
}
