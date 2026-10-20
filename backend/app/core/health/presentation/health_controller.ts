import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { ApiError } from '#core/http/api_error'
import { envelope } from '#core/http/api_response'
import { CheckReadiness } from '#core/health/application/readiness'
import { DatabaseProbe } from '#core/health/infrastructure/database_probe'
import { RedisProbe } from '#core/health/infrastructure/redis_probe'

/**
 * Liveness (`/health`): o processo responde; não toca em dependências, para um orquestrador não o
 * reiniciar por falha de um serviço externo. Readiness (`/ready`): pode receber tráfego.
 * Nenhum dos dois expõe dados de negócio nem de tenants.
 */
export default class HealthController {
  async live(ctx: HttpContext) {
    return envelope(ctx, {
      status: 'ok',
      service: 'sistema-gestao-api',
      environment: app.nodeEnvironment,
    })
  }

  async ready(ctx: HttpContext) {
    const result = await new CheckReadiness([new DatabaseProbe(), new RedisProbe()]).execute()
    const checks = Object.fromEntries(result.checks.map((c) => [c.name, c.ok ? 'up' : 'down']))

    if (!result.ready) {
      throw ApiError.notReady(
        result.checks
          .filter((c) => !c.ok)
          .map((c) => ({ path: c.name, code: 'UNAVAILABLE', message: `${c.name} indisponível.` }))
      )
    }
    return envelope(ctx, { status: 'ready', checks })
  }
}
