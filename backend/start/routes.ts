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
const PreferencesController = () => import('#modules/preferences/http/preferences_controller')
const DashboardController = () => import('#modules/dashboard/http/dashboard_controller')
const SettingsController = () => import('#modules/settings/http/settings_controller')
const AccountingController = () => import('#modules/accounting/http/accounting_controller')
const FixedAssetsController = () => import('#modules/accounting/http/fixed_assets_controller')
const AdjustmentsController = () => import('#modules/accounting/http/adjustments_controller')
const StatementsController = () => import('#modules/accounting/http/statements_controller')
const ClosingController = () => import('#modules/accounting/http/closing_controller')
const EmployeesController = () => import('#modules/hr/http/employees_controller')
const RecruitmentController = () => import('#modules/hr/http/recruitment_controller')

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

            // Contabilidade (Prompt 06): configuração, períodos e lançamentos. Cada acção tem a sua permissão.
            const accounting = (permission: string) => [
              middleware.can({ permission }),
              middleware.entitled({ feature: 'accounting' }),
            ]
            router
              .group(() => {
                for (const segment of ['charts', 'accounts', 'fiscal-years', 'journals']) {
                  const name = segment.replace('-', '_')
                  router
                    .get(`accounting/${segment}`, [AccountingController, 'index'])
                    .as(`accounting.${name}.index`)
                  router
                    .get(`accounting/${segment}/:id`, [AccountingController, 'show'])
                    .as(`accounting.${name}.show`)
                }
                router.get('accounting/entries', [AccountingController, 'entries'])
                router.get('accounting/entries/:id', [AccountingController, 'entry'])
                router.get('accounting/posting-rules', [AccountingController, 'rules'])
                router.get('accounting/posting-rules/:id', [AccountingController, 'rule'])
                router.get('accounting/posting-events', [AccountingController, 'events'])
                router.get('accounting/posting-events/:id', [AccountingController, 'event'])
                router.post('accounting/posting-events/simulate', [
                  AccountingController,
                  'simulate',
                ])
              })
              .use(accounting('accounting.read'))
            router
              .group(() => {
                for (const segment of ['charts', 'accounts', 'fiscal-years', 'journals']) {
                  const name = segment.replace('-', '_')
                  router
                    .post(`accounting/${segment}`, [AccountingController, 'store'])
                    .as(`accounting.${name}.store`)
                  router
                    .patch(`accounting/${segment}/:id`, [AccountingController, 'update'])
                    .as(`accounting.${name}.update`)
                }
              })
              .use(accounting('accounting.settings'))
            router
              .group(() => {
                router.post('accounting/posting-rules', [AccountingController, 'createRule'])
                router.patch('accounting/posting-rules/:id', [AccountingController, 'updateRule'])
              })
              .use(accounting('accounting.settings'))
            router
              .group(() => {
                router.get('accounting/dimensions', [AccountingController, 'dimensions'])
                router.get('accounting/dimensions/:id', [AccountingController, 'dimension'])
                router.get('accounting/allocation-keys', [AccountingController, 'keys'])
                router.get('accounting/allocation-keys/:id', [AccountingController, 'key'])
                router.get('accounting/entries/:id/allocations', [
                  AccountingController,
                  'allocations',
                ])
              })
              .use(accounting('accounting.read'))
            router
              .group(() => {
                router.post('accounting/dimensions', [AccountingController, 'createDimension'])
                router.patch('accounting/dimensions/:id', [AccountingController, 'updateDimension'])
                router.post('accounting/dimensions/:id/values', [
                  AccountingController,
                  'createValue',
                ])
                router.patch('accounting/dimensions/:id/values/:valueId', [
                  AccountingController,
                  'updateValue',
                ])
                router.post('accounting/allocation-keys', [AccountingController, 'createKey'])
                router.patch('accounting/allocation-keys/:id', [AccountingController, 'updateKey'])
              })
              .use(accounting('accounting.settings'))
            router
              .group(() => {
                router.put('accounting/entries/:id/lines/:lineNo/allocations', [
                  AccountingController,
                  'setAllocations',
                ])
                router.get('accounting/analytics', [AccountingController, 'analyticReport'])
              })
              .use(accounting('accounting.analytics'))
            router
              .group(() => {
                router.get('accounting/trial-balance', [AccountingController, 'trialBalance'])
                router.get('accounting/ledger', [AccountingController, 'ledger'])
              })
              .use(accounting('accounting.reports'))
            router
              .group(() => {
                router.post('accounting/opening-balances/validate', [
                  AccountingController,
                  'validateOpening',
                ])
                router.post('accounting/opening-balances', [AccountingController, 'importOpening'])
              })
              .use(accounting('accounting.create'))
            router
              .group(() => {
                router.post('accounting/posting-events', [AccountingController, 'submitEvent'])
                router.post('accounting/posting-events/:id/retry', [
                  AccountingController,
                  'retryEvent',
                ])
              })
              .use(accounting('accounting.post'))
            router
              .post('accounting/periods/:id/close', [ClosingController, 'closePeriod'])
              .use(accounting('accounting.close'))
            router
              .post('accounting/periods/:id/reopen', [AccountingController, 'reopenPeriod'])
              .use(accounting('accounting.reopen'))
            router
              .group(() => {
                router.post('accounting/entries', [AccountingController, 'createEntry'])
                router.patch('accounting/entries/:id', [AccountingController, 'updateEntry'])
                router.delete('accounting/entries/:id', [AccountingController, 'deleteEntry'])
                router.post('accounting/entries/:id/submit', [AccountingController, 'submit'])
              })
              .use(accounting('accounting.create'))
            router.group(() => {
              router
                .post('accounting/entries/:id/approve', [AccountingController, 'approve'])
                .use(accounting('accounting.approve'))
              router
                .post('accounting/entries/:id/reject', [AccountingController, 'reject'])
                .use(accounting('accounting.approve'))
              router
                .post('accounting/entries/:id/post', [AccountingController, 'post'])
                .use(accounting('accounting.post'))
              router
                .post('accounting/entries/:id/reverse', [AccountingController, 'reverse'])
                .use(accounting('accounting.reverse'))
            })

            // Fecho (6.10): checklist (accounting.read), tarefas e encerramento (accounting.close), reabertura do
            // exercício (accounting.reopen).
            router
              .group(() => {
                router.get('accounting/periods/:id/checklist', [ClosingController, 'checklist'])
                router.get('accounting/fiscal-years/:id/closing', [ClosingController, 'yearStatus'])
              })
              .use(accounting('accounting.read'))
            router
              .group(() => {
                router.post('accounting/periods/:id/tasks', [ClosingController, 'addTask'])
                router.post('accounting/periods/:id/tasks/copy', [ClosingController, 'copyTasks'])
                router.patch('accounting/close-tasks/:id', [ClosingController, 'updateTask'])
                router.delete('accounting/close-tasks/:id', [ClosingController, 'deleteTask'])
                router.post('accounting/fiscal-years/:id/close', [ClosingController, 'closeYear'])
              })
              .use(accounting('accounting.close'))
            router
              .post('accounting/fiscal-years/:id/reopen', [ClosingController, 'reopenYear'])
              .use(accounting('accounting.reopen'))

            // Demonstrações financeiras (6.8): modelos (accounting.read / accounting.settings), demonstrações e notas
            // (accounting.reports), redacção das notas (accounting.statements).
            const ST = 'accounting/statement-templates'
            router
              .group(() => {
                router.get(ST, [StatementsController, 'templates'])
                router.get(`${ST}/:id`, [StatementsController, 'template'])
              })
              .use(accounting('accounting.read'))
            router
              .group(() => {
                router.post(ST, [StatementsController, 'createTemplate'])
                router.patch(`${ST}/:id`, [StatementsController, 'updateTemplate'])
                router.delete(`${ST}/:id`, [StatementsController, 'deleteTemplate'])
                router.post(`${ST}/:id/publish`, [StatementsController, 'publishTemplate'])
                router.post(`${ST}/:id/versions`, [StatementsController, 'newVersion'])
              })
              .use(accounting('accounting.settings'))
            router
              .group(() => {
                router.get('accounting/statements', [StatementsController, 'generate'])
                router.get('accounting/statement-notes', [StatementsController, 'notes'])
              })
              .use(accounting('accounting.reports'))
            router
              .group(() => {
                router.post('accounting/statement-notes', [StatementsController, 'createNote'])
                router.patch('accounting/statement-notes/:id', [StatementsController, 'updateNote'])
                router.delete('accounting/statement-notes/:id', [
                  StatementsController,
                  'deleteNote',
                ])
              })
              .use(accounting('accounting.statements'))

            // Regularizações (6.7): consulta com accounting.read; gerar rascunhos com accounting.adjustments;
            // reconciliar com accounting.reconcile.
            router
              .group(() => {
                router.get('accounting/adjustment-schedules', [AdjustmentsController, 'schedules'])
                router.get('accounting/adjustment-schedules/:id', [
                  AdjustmentsController,
                  'schedule',
                ])
                router.get('accounting/provisions', [AdjustmentsController, 'provisions'])
                router.get('accounting/provisions/:id', [AdjustmentsController, 'provision'])
                router.get('accounting/fx-revaluations', [AdjustmentsController, 'revaluations'])
                router.get('accounting/reconciliations', [AdjustmentsController, 'reconciliations'])
                router.get('accounting/reconciliations/open-items', [
                  AdjustmentsController,
                  'openItems',
                ])
              })
              .use(accounting('accounting.read'))
            router
              .group(() => {
                router.post('accounting/adjustment-schedules', [
                  AdjustmentsController,
                  'createSchedule',
                ])
                router.patch('accounting/adjustment-schedules/:id', [
                  AdjustmentsController,
                  'updateSchedule',
                ])
                router.get('accounting/adjustments/preview', [
                  AdjustmentsController,
                  'previewSchedules',
                ])
                router.post('accounting/adjustments/generate', [
                  AdjustmentsController,
                  'generateSchedules',
                ])
                router.post('accounting/provisions', [AdjustmentsController, 'createProvision'])
                router.patch('accounting/provisions/:id', [
                  AdjustmentsController,
                  'updateProvision',
                ])
                router.post('accounting/provisions/:id/movements', [
                  AdjustmentsController,
                  'moveProvision',
                ])
                router.get('accounting/fx-revaluations/preview', [
                  AdjustmentsController,
                  'previewRevaluation',
                ])
                router.post('accounting/fx-revaluations', [AdjustmentsController, 'revalue'])
              })
              .use(accounting('accounting.adjustments'))
            router
              .group(() => {
                router.post('accounting/reconciliations', [AdjustmentsController, 'reconcile'])
                router.delete('accounting/reconciliations/:id', [
                  AdjustmentsController,
                  'undoReconciliation',
                ])
              })
              .use(accounting('accounting.reconcile'))

            // Activos fixos (6.6): consulta, gestão das fichas e contabilização (aquisição, depreciação, abate).
            const FA = 'accounting/fixed-assets'
            router
              .group(() => {
                router.get('accounting/fixed-asset-classes', [FixedAssetsController, 'classes'])
                router.get('accounting/fixed-asset-classes/:id', [
                  FixedAssetsController,
                  'showClass',
                ])
                router.get(FA, [FixedAssetsController, 'index'])
                router.get(`${FA}/depreciation/preview`, [FixedAssetsController, 'preview'])
                router.get(`${FA}/depreciation-map`, [FixedAssetsController, 'map'])
                router.get(`${FA}/:id`, [FixedAssetsController, 'show'])
              })
              .use(accounting('fixed_assets.read'))
            router
              .group(() => {
                router.post('accounting/fixed-asset-classes', [
                  FixedAssetsController,
                  'createClass',
                ])
                router.patch('accounting/fixed-asset-classes/:id', [
                  FixedAssetsController,
                  'updateClass',
                ])
                router.post(FA, [FixedAssetsController, 'store'])
                router.patch(`${FA}/:id`, [FixedAssetsController, 'update'])
                router.delete(`${FA}/:id`, [FixedAssetsController, 'destroy'])
                router.post(`${FA}/:id/transfer`, [FixedAssetsController, 'transfer'])
              })
              .use(accounting('fixed_assets.manage'))
            router
              .group(() => {
                router.post(`${FA}/:id/acquire`, [FixedAssetsController, 'acquire'])
                router.post(`${FA}/:id/dispose`, [FixedAssetsController, 'dispose'])
                router.post(`${FA}/:id/reverse-acquisition`, [
                  FixedAssetsController,
                  'reverseAcquisition',
                ])
                router.post(`${FA}/:id/reverse-disposal`, [
                  FixedAssetsController,
                  'reverseDisposal',
                ])
                router.post(`${FA}/depreciation/run`, [FixedAssetsController, 'run'])
                router.post(`${FA}/depreciation/undo`, [FixedAssetsController, 'undo'])
              })
              .use(accounting('fixed_assets.post'))

            router
              .get('audit-events', [AuditController, 'index'])
              .use(middleware.can({ permission: 'audit.read' }))

            // Caixa pessoal: notificações e tarefas do membro em contexto (sem permissão extra).
            router.get('me/notifications', [NotificationsController, 'index'])
            router.post('me/notifications/read-all', [NotificationsController, 'readAll'])
            router.post('me/notifications/:id/read', [NotificationsController, 'read'])
            router.get('me/tasks', [TasksController, 'index'])
            router.get('me/preferences/:key', [PreferencesController, 'show'])
            router.put('me/preferences/:key', [PreferencesController, 'update'])
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

            // Recursos humanos (Prompt 07): o âmbito RBAC (empresa, entidade, filial, departamento, próprio) e os dados
            // pessoais são verificados no serviço com hr.read / hr.manage / hr.sensitive; o recrutamento com
            // hr.recruitment.read / manage / approve sobre a colocação da vaga.
            router
              .group(() => {
                router.get('employees', [EmployeesController, 'index'])
                router.post('employees', [EmployeesController, 'store'])
                router.get('employees/:id', [EmployeesController, 'show'])
                router.patch('employees/:id', [EmployeesController, 'update'])
                router.post('employees/:id/status', [EmployeesController, 'setStatus'])
                router.get('employees/:id/onboarding', [RecruitmentController, 'onboarding'])
                router.post('employees/:id/onboarding', [
                  RecruitmentController,
                  'createOnboardingTask',
                ])
                router.patch('onboarding-tasks/:id', [
                  RecruitmentController,
                  'updateOnboardingTask',
                ])
                router
                  .get('settings', [RecruitmentController, 'settings'])
                  .use(middleware.can({ permission: 'hr.settings' }))
                router
                  .put('settings', [RecruitmentController, 'updateSettings'])
                  .use(middleware.can({ permission: 'hr.settings' }))
                router.get('requisitions', [RecruitmentController, 'requisitions'])
                router.post('requisitions', [RecruitmentController, 'createRequisition'])
                router.get('requisitions/:id', [RecruitmentController, 'requisition'])
                router.patch('requisitions/:id', [RecruitmentController, 'updateRequisition'])
                router.post('requisitions/:id/submit', [RecruitmentController, 'submitRequisition'])
                router.post('requisitions/:id/decision', [
                  RecruitmentController,
                  'decideRequisition',
                ])
                router.post('requisitions/:id/close', [RecruitmentController, 'closeRequisition'])
                router.post('requisitions/:id/cancel', [RecruitmentController, 'cancelRequisition'])
                router.get('candidates', [RecruitmentController, 'candidates'])
                router.post('candidates', [RecruitmentController, 'createCandidate'])
                router.get('candidates/:id', [RecruitmentController, 'candidate'])
                router.patch('candidates/:id', [RecruitmentController, 'updateCandidate'])
                router.get('applications', [RecruitmentController, 'applications'])
                router.post('applications', [RecruitmentController, 'createApplication'])
                router.get('applications/:id', [RecruitmentController, 'application'])
                router.post('applications/:id/stage', [RecruitmentController, 'changeStage'])
                router.post('applications/:id/interviews', [
                  RecruitmentController,
                  'scheduleInterview',
                ])
                router.post('applications/:id/evaluations', [RecruitmentController, 'evaluate'])
                router.post('applications/:id/offers', [RecruitmentController, 'createOffer'])
                router.get('interviews/mine', [RecruitmentController, 'myInterviews'])
                router.patch('interviews/:id', [RecruitmentController, 'updateInterview'])
                router.patch('offers/:id', [RecruitmentController, 'updateOffer'])
                router.post('offers/:id/submit', [RecruitmentController, 'submitOffer'])
                router.post('offers/:id/decision', [RecruitmentController, 'decideOffer'])
                router.post('offers/:id/response', [RecruitmentController, 'respondOffer'])
                router.post('offers/:id/cancel', [RecruitmentController, 'cancelOffer'])
                router.post('offers/:id/hire', [RecruitmentController, 'hire'])
              })
              .prefix('hr')
              .use(middleware.entitled({ feature: 'hr' }))

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
