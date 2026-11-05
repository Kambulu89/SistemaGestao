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
const TenantSubscriptionController = () =>
  import('#modules/subscription/http/tenant_subscription_controller')
const PlatformController = () => import('#modules/platform/http/platform_controller')
const AuditController = () => import('#modules/audit/http/audit_controller')
const NotificationsController = () => import('#modules/notifications/http/notifications_controller')
const ApprovalsController = () => import('#modules/approvals/http/approvals_controller')
const AttachmentsController = () => import('#modules/attachments/http/attachments_controller')
const TasksController = () => import('#modules/tasks/http/tasks_controller')

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
              .use([
                middleware.can({ permission: 'organization.read' }),
                middleware.entitled({ feature: 'organization' }),
              ])
            router
              .group(() => {
                router.post('organization/:kind', [OrganizationController, 'store'])
                router.patch('organization/:kind/:id', [OrganizationController, 'update'])
              })
              .use([
                middleware.can({ permission: 'organization.manage' }),
                middleware.entitled({ feature: 'organization' }),
              ])

            router
              .get('tenant/subscription', [TenantSubscriptionController, 'show'])
              .use(middleware.can({ permission: 'subscription.read' }))

            router
              .get('audit-events', [AuditController, 'index'])
              .use(middleware.can({ permission: 'audit.read' }))

            // Caixa pessoal: notificações e tarefas do membro em contexto (sem permissão extra).
            router.get('me/notifications', [NotificationsController, 'index'])
            router.post('me/notifications/read-all', [NotificationsController, 'readAll'])
            router.post('me/notifications/:id/read', [NotificationsController, 'read'])
            router.get('me/tasks', [TasksController, 'index'])

            // Aprovações: decidir depende de ser aprovador da etapa (ou delegado), não de uma permissão.
            router
              .group(() => {
                router
                  .group(() => {
                    router.get('workflows', [ApprovalsController, 'workflows'])
                    router.post('workflows', [ApprovalsController, 'createWorkflow'])
                    router.get('workflows/:id', [ApprovalsController, 'workflow'])
                    router.patch('workflows/:id', [ApprovalsController, 'updateWorkflow'])
                    router.delete('workflows/:id', [ApprovalsController, 'deleteWorkflow'])
                    router.post('workflows/:id/publish', [ApprovalsController, 'publishWorkflow'])
                    router.post('workflows/:id/retire', [ApprovalsController, 'retireWorkflow'])
                  })
                  .use(middleware.can({ permission: 'approvals.manage' }))
                router
                  .group(() => {
                    router.get('available-workflows', [ApprovalsController, 'activeWorkflows'])
                    router.post('requests', [ApprovalsController, 'submit'])
                  })
                  .use(middleware.can({ permission: 'approvals.request' }))
                router.get('requests', [ApprovalsController, 'requests'])
                router.get('requests/:id', [ApprovalsController, 'request'])
                router.post('requests/:id/decisions', [ApprovalsController, 'decide'])
                router.post('requests/:id/cancel', [ApprovalsController, 'cancel'])
                router.get('delegations', [ApprovalsController, 'delegations'])
                router.post('delegations', [ApprovalsController, 'createDelegation'])
                router.post('delegations/:id/revoke', [ApprovalsController, 'revokeDelegation'])
              })
              .prefix('approvals')
              .use(middleware.entitled({ feature: 'approvals' }))

            // Anexos: o acesso (e a funcionalidade) herda do registo a que pertencem.
            router.get('attachments', [AttachmentsController, 'index'])
            router.post('attachments', [AttachmentsController, 'store'])
            router.get('attachments/:id/content', [AttachmentsController, 'download'])
            router.delete('attachments/:id', [AttachmentsController, 'destroy'])
          })
          .use(middleware.tenant())

        // Administração da plataforma (plano de controlo, sem tenant em contexto).
        router
          .group(() => {
            router.get('features', [PlatformController, 'features'])
            router.get('plans', [PlatformController, 'plans'])
            router.post('plans', [PlatformController, 'createPlan'])
            router.get('plans/:id', [PlatformController, 'plan'])
            router.patch('plans/:id', [PlatformController, 'updatePlan'])
            router.post('plans/:id/publish', [PlatformController, 'publishPlan'])
            router.post('plans/:id/retire', [PlatformController, 'retirePlan'])
            router.get('tenants', [PlatformController, 'tenants'])
            router.post('tenants', [PlatformController, 'createTenant'])
            router.patch('tenants/:id', [PlatformController, 'updateTenant'])
            router.get('tenants/:id/subscription', [PlatformController, 'subscription'])
            router.post('tenants/:id/subscription', [PlatformController, 'startSubscription'])
            router.put('tenants/:id/entitlements/:feature', [PlatformController, 'setOverride'])
            router.delete('tenants/:id/entitlements/:feature', [
              PlatformController,
              'removeOverride',
            ])
            router.post('subscriptions/:id/transitions', [
              PlatformController,
              'transitionSubscription',
            ])
          })
          .prefix('platform')
          .use(middleware.platformAdmin())
      })
      .use(middleware.auth())
  })
  .prefix('/api/v1')
