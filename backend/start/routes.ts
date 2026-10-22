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
const ContextController = () => import('#platform/tenants/presentation/context_controller')
const IamController = () => import('#core/permissions/presentation/iam_controller')
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
        router.get('/me/tenants', [ContextController, 'myTenants'])
      })
      .use(middleware.auth())
  })
  .prefix('/api/v1')
  .use(middleware.origin())

/** Rotas de tenant: sessão + selector validado contra a membership activa. */
router
  .group(() => {
    router.get('/context', [ContextController, 'show'])
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/** Autorização (C06): leitura com `iam.read`, escrita com `iam.manage`. */
router
  .group(() => {
    router
      .group(() => {
        router.get('/permissions', [IamController, 'permissions'])
        router.get('/roles', [IamController, 'listRoles'])
        router.get('/roles/:id', [IamController, 'showRole'])
        router.get('/role-assignments', [IamController, 'listAssignments'])
        router.get('/access-policies', [IamController, 'listPolicies'])
      })
      .use(middleware.can({ permission: 'iam.read' }))

    router
      .group(() => {
        router.post('/roles', [IamController, 'createRole'])
        router.patch('/roles/:id', [IamController, 'updateRole'])
        router.delete('/roles/:id', [IamController, 'deleteRole'])
        router.post('/role-assignments', [IamController, 'assign'])
        router.delete('/role-assignments/:id', [IamController, 'revoke'])
        router.post('/access-policies', [IamController, 'createPolicy'])
        router.patch('/access-policies/:id', [IamController, 'updatePolicy'])
        router.post('/authorization/simulate', [IamController, 'simulate'])
      })
      .use(middleware.can({ permission: 'iam.manage' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])
