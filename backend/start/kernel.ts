import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

server.errorHandler(() => import('#exceptions/handler'))

server.use([
  () => import('#middleware/force_json_response_middleware'),
  () => import('#middleware/container_bindings_middleware'),
  () => import('@adonisjs/cors/cors_middleware'),
])

router.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
  () => import('@adonisjs/shield/shield_middleware'),
])

export const middleware = router.named({
  auth: () => import('#modules/identity/http/auth_middleware'),
  tenant: () => import('#modules/tenancy/http/tenant_middleware'),
  can: () => import('#modules/rbac/http/can_middleware'),
})
