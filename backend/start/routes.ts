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
const DashboardController = () => import('#modules/dashboard/http/dashboard_controller')
const SettingsController = () => import('#modules/settings/http/settings_controller')

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
              .group(() => {
                router.post('members/invitations', [MembersController, 'invite'])
                router.post('members/:id/invitation/resend', [
                  MembersController,
                  'resendInvitation',
                ])
                router.delete('members/:id/invitation', [MembersController, 'revokeInvitation'])
              })
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
                router.get('organization/:kind/tree', [OrganizationController, 'tree'])
                router.get('organization/:kind/:id', [OrganizationController, 'show'])
                router.get('organization/:kind/:id/dependents', [
                  OrganizationController,
                  'dependents',
                ])
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

            // Administração empresarial: perfil, configurações e dados de referência (Prompt 05).
            router
              .group(() => {
                router.get('company/profile', [SettingsController, 'profile'])
                router.get('settings', [SettingsController, 'settings'])
                router
                  .get('exchange-rates', [SettingsController, 'index'])
                  .as('exchange_rates.index')
                router.get('exchange-rates/lookup', [SettingsController, 'lookupRate'])
                router
                  .get('exchange-rates/:id', [SettingsController, 'show'])
                  .as('exchange_rates.show')
                router
                  .get('document-series', [SettingsController, 'index'])
                  .as('document_series.index')
                router
                  .get('document-series/:id', [SettingsController, 'show'])
                  .as('document_series.show')
                router.get('document-series/:id/preview', [SettingsController, 'previewSeries'])
                router.get('calendars', [SettingsController, 'index']).as('calendars.index')
                router.get('calendars/:id', [SettingsController, 'show']).as('calendars.show')
                router.get('calendars/:id/working-days', [SettingsController, 'workingDays'])
              })
              .use(middleware.can({ permission: 'settings.read' }))
            router
              .group(() => {
                router.put('company/profile', [SettingsController, 'updateProfile'])
                router.put('settings', [SettingsController, 'updateSettings'])
                router
                  .post('exchange-rates', [SettingsController, 'store'])
                  .as('exchange_rates.store')
                router
                  .patch('exchange-rates/:id', [SettingsController, 'update'])
                  .as('exchange_rates.update')
                router
                  .post('document-series', [SettingsController, 'store'])
                  .as('document_series.store')
                router
                  .patch('document-series/:id', [SettingsController, 'update'])
                  .as('document_series.update')
                router.post('calendars', [SettingsController, 'store']).as('calendars.store')
                router.patch('calendars/:id', [SettingsController, 'update']).as('calendars.update')
                router.post('calendars/:id/holidays', [SettingsController, 'addHoliday'])
                router.delete('calendars/:id/holidays/:holidayId', [
                  SettingsController,
                  'removeHoliday',
                ])
              })
              .use(middleware.can({ permission: 'settings.manage' }))
            router
              .group(() => {
                router.get('bank-accounts', [SettingsController, 'index']).as('bank_accounts.index')
                router
                  .get('bank-accounts/:id', [SettingsController, 'show'])
                  .as('bank_accounts.show')
              })
              .use(middleware.can({ permission: 'bank_accounts.read' }))
            router
              .group(() => {
                router
                  .post('bank-accounts', [SettingsController, 'store'])
                  .as('bank_accounts.store')
                router
                  .patch('bank-accounts/:id', [SettingsController, 'update'])
                  .as('bank_accounts.update')
              })
              .use(middleware.can({ permission: 'bank_accounts.manage' }))

            router
              .get('audit-events', [AuditController, 'index'])
              .use(middleware.can({ permission: 'audit.read' }))

            // Caixa pessoal: notificações e tarefas do membro em contexto (sem permissão extra).
            router.get('me/notifications', [NotificationsController, 'index'])
            router.post('me/notifications/read-all', [NotificationsController, 'readAll'])
            router.post('me/notifications/:id/read', [NotificationsController, 'read'])
            router.get('me/tasks', [TasksController, 'index'])
            // Painel e pesquisa: cada secção/fonte aplica as permissões e funcionalidades do módulo dono.
            router.get('dashboard', [DashboardController, 'summary'])
            router.get('search', [DashboardController, 'search'])

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
            router.get('tenants/:id', [PlatformController, 'tenant'])
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
