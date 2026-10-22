/*
|--------------------------------------------------------------------------
| Rotas
|--------------------------------------------------------------------------
|
| Base `/api/v1`. As rotas públicas e de plataforma ficam sempre separadas das rotas de tenant;
| não existe "tenant por omissão".
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AuthController = () => import('#core/auth/presentation/auth_controller')
const MeController = () => import('#core/auth/presentation/me_controller')
const HealthController = () => import('#core/health/presentation/health_controller')

router
  .group(() => {
    router.get('/health', [HealthController, 'live'])
    router.get('/ready', [HealthController, 'ready'])
  })
  .prefix('/api/v1')

/** Autenticação (C04). Públicas: login, recuperação e verificação; o resto exige sessão. */
router
  .group(() => {
    router.post('/auth/login', [AuthController, 'login'])
    router.post('/auth/forgot-password', [AuthController, 'forgotPassword'])
    router.post('/auth/reset-password', [AuthController, 'resetPassword'])
    router.post('/auth/verify-email', [AuthController, 'verifyEmail'])

    router
      .group(() => {
        router.post('/auth/logout', [AuthController, 'logout'])
        router.get('/me', [MeController, 'show'])
        router.get('/me/sessions', [MeController, 'sessions'])
        router.delete('/me/sessions/:id', [MeController, 'revokeSession'])
        router.post('/me/password', [MeController, 'changePassword'])
      })
      .use(middleware.auth())
  })
  .prefix('/api/v1')
  .use(middleware.origin())
