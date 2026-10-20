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

/** Middleware de rota (só nas rotas registadas). Vazio até haver autenticação e contexto de tenant. */
router.use([() => import('@adonisjs/core/bodyparser_middleware')])

export const middleware = router.named({})
