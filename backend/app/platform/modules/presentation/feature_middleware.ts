import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ApiError } from '#core/http/api_error'
import { moduleServices } from '#platform/modules/presentation/composition'

/**
 * Exige uma funcionalidade efectiva (licença AND módulo activo AND funcionalidade ligada) para a rota,
 * depois de `auth` e `tenant`. Esconder um item de menu não basta: é a API que bloqueia.
 */
export default class FeatureMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { code: string }) {
    if (!(await moduleServices().isFeatureEnabled.execute(ctx.tenantContext, options.code))) {
      throw new ApiError(
        403,
        'FEATURE_NOT_AVAILABLE',
        'Esta funcionalidade não está disponível para o tenant.'
      )
    }
    return next()
  }
}
