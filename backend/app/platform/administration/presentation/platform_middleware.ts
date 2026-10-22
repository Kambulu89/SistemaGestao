import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ApiError } from '#core/http/api_error'
import { securityEvents } from '#core/audit/index'
import { administrationServices } from '#platform/administration/presentation/composition'
import type { PlatformPermission } from '#platform/administration/domain/platform'

/**
 * Política própria das rotas de plataforma (depois de `auth`, **sem** `tenant`): exige uma concessão
 * `platform.*` em vigor. Não há selector de tenant e a concessão não dá acesso a dados de tenants.
 */
export default class PlatformMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { permission: PlatformPermission }) {
    const userId = ctx.principal.user.id
    if (!(await administrationServices().authorize.has(userId, options.permission))) {
      await securityEvents.record({
        type: 'PLATFORM_ACCESS_DENIED',
        severity: 'HIGH',
        userId,
        metadata: { permission: options.permission, method: ctx.request.method() },
      })
      throw new ApiError(
        403,
        'PLATFORM_PERMISSION_DENIED',
        'Sem permissão de administração da plataforma.'
      )
    }
    return next()
  }
}
