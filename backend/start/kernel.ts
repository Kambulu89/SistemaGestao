/*
|--------------------------------------------------------------------------
| HTTP kernel
|--------------------------------------------------------------------------
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

server.errorHandler(() => import('#exceptions/handler'))

/**
 * Middleware de servidor: corre em todos os pedidos, mesmo quando não há rota.
 * A ordem importa: o correlation id tem de existir antes de qualquer log ou erro.
 */
server.use([
  () => import('#middleware/container_bindings_middleware'),
  () => import('#middleware/correlation_id_middleware'),
  () => import('#middleware/force_json_response_middleware'),
  () => import('@adonisjs/cors/cors_middleware'),
])

/** Middleware de rota (só nas rotas registadas). */
router.use([() => import('@adonisjs/core/bodyparser_middleware')])

export const middleware = router.named({
  /** Sessão opaca em cookie + CSRF nas escritas. */
  auth: () => import('#core/auth/presentation/auth_middleware'),
  /** Resolve o tenant do pedido (depois de `auth`): selector + membership activa + tenant activo. */
  tenant: () => import('#platform/tenants/presentation/tenant_middleware'),
  /** Exige uma permissão (depois de `tenant`): `middleware.can({ permission: 'iam.manage' })`. */
  can: () => import('#core/permissions/presentation/permission_middleware'),
  /** Política das rotas de plataforma (depois de `auth`, sem `tenant`): `middleware.platform({ permission: 'platform.tenant.manage' })`. */
  platform: () => import('#platform/administration/presentation/platform_middleware'),
  /** Exige uma funcionalidade efectiva (depois de `tenant`): `middleware.feature({ code: 'sales.quotes' })`. */
  feature: () => import('#platform/modules/presentation/feature_middleware'),
  /** Rejeita `Origin` de browser fora da lista permitida nas escritas. */
  origin: async () => {
    const { OriginMiddleware } = await import('#core/auth/presentation/auth_middleware')
    return { default: OriginMiddleware }
  },
})
