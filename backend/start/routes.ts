/*
| Rotas da API (`/api/v1`). Cada módulo expõe os seus controllers em `app/modules/<módulo>/http`.
| `auth`: sessão válida + CSRF nos métodos que alteram dados. `tenant`: contexto de tenant resolvido no servidor.
*/
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const HealthController = () => import('#modules/health/http/health_controller')
const AuthController = () => import('#modules/identity/http/auth_controller')
const ContextController = () => import('#modules/tenancy/http/context_controller')

router
  .group(() => {
    router.get('health', [HealthController, 'show'])

    router.post('auth/login', [AuthController, 'login'])

    router
      .group(() => {
        router.get('auth/me', [AuthController, 'me'])
        router.post('auth/logout', [AuthController, 'logout'])

        router
          .group(() => {
            router.get('context', [ContextController, 'show'])
          })
          .use(middleware.tenant())
      })
      .use(middleware.auth())
  })
  .prefix('/api/v1')
