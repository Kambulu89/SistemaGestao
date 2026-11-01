import type { HttpContext } from '@adonisjs/core/http'
import { envelope } from '#core/http/api_response'
import { moduleServices } from '#platform/modules/presentation/composition'
import {
  enableValidator,
  featureOverrideValidator,
} from '#platform/modules/presentation/validators'

export default class ModulesController {
  /** Catálogo com dependências, licença, estado e diagnóstico (módulos a activar antes, dependentes activos). */
  async list(ctx: HttpContext) {
    return envelope(ctx, await moduleServices().listModules.execute(ctx.tenantContext))
  }

  async enable(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(enableValidator)
    return envelope(
      ctx,
      await moduleServices().enableModule.execute(ctx.tenantContext, ctx.params.code, body)
    )
  }

  async disable(ctx: HttpContext) {
    return envelope(
      ctx,
      await moduleServices().disableModule.execute(ctx.tenantContext, ctx.params.code)
    )
  }

  /** Funcionalidades efectivas do tenant (para a interface; a API volta a verificar em cada comando). */
  async features(ctx: HttpContext) {
    const features = await moduleServices().listFeatures.execute(ctx.tenantContext)
    return envelope(
      ctx,
      features.map((f) => ({
        code: f.code,
        moduleCode: f.moduleCode,
        enabled: f.enabled,
        reason: f.reason,
      }))
    )
  }

  async setOverride(ctx: HttpContext) {
    const body = await ctx.request.validateUsing(featureOverrideValidator)
    return envelope(
      ctx,
      await moduleServices().setFeatureOverride.execute(ctx.tenantContext, ctx.params.code, {
        override: body.override,
        reason: body.reason ?? null,
        expiresAt: body.expiresAt ?? null,
      })
    )
  }
}
