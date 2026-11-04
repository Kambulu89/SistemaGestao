/*
| Rotas da API (`/api/v1`). Cada módulo expõe os seus controllers em `app/modules/<módulo>/http`.
| `auth`: sessão válida + CSRF nos métodos que alteram dados. `tenant`: contexto de tenant resolvido no servidor.
| `can({ permission })`: permissão RBAC com âmbito de empresa (negar por omissão).
*/
import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const HealthController = () => import('#modules/health/http/health_controller')
const AuthController = () => import('#modules/identity/http/auth_controller')
const AccountController = () => import('#modules/identity/http/account_controller')
const ContextController = () => import('#modules/tenancy/http/context_controller')
const RolesController = () => import('#modules/rbac/http/roles_controller')
const MembersController = () => import('#modules/members/http/members_controller')
const InvitationController = () => import('#modules/members/http/invitation_controller')
const OrganizationController = () => import('#modules/organization/http/organization_controller')

router
  .group(() => {
    router.get('health', [HealthController, 'show'])

    // Públicas (com limites de tentativas e respostas genéricas).
    router.post('auth/login', [AuthController, 'login'])
    router.post('auth/password/forgot', [AccountController, 'forgotPassword'])
    router.post('auth/password/reset', [AccountController, 'resetPassword'])
    router.post('auth/invitations/accept', [InvitationController, 'accept'])

    router
      .group(() => {
        router.get('auth/me', [AuthController, 'me'])
        router.post('auth/logout', [AuthController, 'logout'])
        router.get('auth/sessions', [AccountController, 'sessions'])
        router.delete('auth/sessions/:id', [AccountController, 'revokeSession'])
        router.get('permissions', [RolesController, 'permissions'])

        router
          .group(() => {
            router.get('context', [ContextController, 'show'])
            router.get('me/permissions', [RolesController, 'mine'])

            router
              .get('roles', [RolesController, 'index'])
              .use(middleware.can({ permission: 'roles.read' }))
            router
              .get('roles/:id', [RolesController, 'show'])
              .use(middleware.can({ permission: 'roles.read' }))
            router
              .group(() => {
                router.post('roles', [RolesController, 'store'])
                router.patch('roles/:id', [RolesController, 'update'])
                router.delete('roles/:id', [RolesController, 'destroy'])
              })
              .use(middleware.can({ permission: 'roles.manage' }))

            router
              .group(() => {
                router.get('members', [MembersController, 'index'])
                router.get('members/:id', [MembersController, 'show'])
              })
              .use(middleware.can({ permission: 'members.read' }))
            router
              .post('members/invitations', [MembersController, 'invite'])
              .use(middleware.can({ permission: 'members.invite' }))
            router
              .group(() => {
                router.post('members/:id/suspend', [MembersController, 'suspend'])
                router.post('members/:id/reactivate', [MembersController, 'reactivate'])
                router.post('members/:id/roles', [MembersController, 'assignRole'])
                router.delete('members/:id/roles/:assignmentId', [
                  MembersController,
                  'unassignRole',
                ])
              })
              .use(middleware.can({ permission: 'members.manage' }))

            // Estrutura organizacional: :kind = legal-entities | branches | departments | positions | cost-centers
            router
              .group(() => {
                router.get('organization/:kind', [OrganizationController, 'index'])
                router.get('organization/:kind/:id', [OrganizationController, 'show'])
              })
              .use(middleware.can({ permission: 'organization.read' }))
            router
              .group(() => {
                router.post('organization/:kind', [OrganizationController, 'store'])
                router.patch('organization/:kind/:id', [OrganizationController, 'update'])
              })
              .use(middleware.can({ permission: 'organization.manage' }))
          })
          .use(middleware.tenant())
      })
      .use(middleware.auth())
  })
  .prefix('/api/v1')
