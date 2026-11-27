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
const CareerController = () => import('#modules/hr/http/career_controller')
const LeaveController = () => import('#modules/hr/http/leave_controller')
const CompensationController = () => import('#modules/hr/http/compensation_controller')
const LoansController = () => import('#modules/hr/http/loans_controller')
const PayrollController = () => import('#modules/hr/http/payroll_controller')
const TrainingController = () => import('#modules/hr/http/training_controller')
const TerminationsController = () => import('#modules/hr/http/terminations_controller')
const PortalController = () => import('#modules/hr/http/portal_controller')
const CatalogController = () => import('#modules/inventory/http/catalog_controller')
const WarehousesController = () => import('#modules/inventory/http/warehouses_controller')
const StockController = () => import('#modules/inventory/http/stock_controller')
const TransfersController = () => import('#modules/inventory/http/transfers_controller')
const RequisitionsController = () => import('#modules/inventory/http/requisitions_controller')
const CountsController = () => import('#modules/inventory/http/counts_controller')
const LotsController = () => import('#modules/inventory/http/lots_controller')
const ValuationController = () => import('#modules/inventory/http/valuation_controller')
const InventoryReportsController = () => import('#modules/inventory/http/reports_controller')
const SuppliersController = () => import('#modules/procurement/http/suppliers_controller')
const PurchaseRequisitionsController = () =>
  import('#modules/procurement/http/requisitions_controller')
const RfqsController = () => import('#modules/procurement/http/rfqs_controller')
const PurchaseOrdersController = () => import('#modules/procurement/http/orders_controller')
const ContractsController = () => import('#modules/procurement/http/contracts_controller')
const ReceiptsController = () => import('#modules/procurement/http/receipts_controller')
const InvoicesController = () => import('#modules/procurement/http/invoices_controller')
const ReturnsController = () => import('#modules/procurement/http/returns_controller')
const CreditNotesController = () => import('#modules/procurement/http/credit_notes_controller')
const ProcurementFinanceController = () => import('#modules/procurement/http/finance_controller')
const EvaluationsController = () => import('#modules/procurement/http/evaluations_controller')
const CustomersController = () => import('#modules/sales/http/customers_controller')
const PricingController = () => import('#modules/sales/http/pricing_controller')
const QuotesController = () => import('#modules/sales/http/quotes_controller')
const OrdersController = () => import('#modules/sales/http/orders_controller')
const FiscalController = () => import('#modules/sales/http/fiscal_controller')
const SalesInvoicesController = () => import('#modules/sales/http/sales_invoices_controller')
const SalesReceiptsController = () => import('#modules/sales/http/sales_receipts_controller')
const SalesNotesController = () => import('#modules/sales/http/sales_notes_controller')
const CollectionsController = () => import('#modules/sales/http/collections_controller')
const RecurringController = () => import('#modules/sales/http/recurring_controller')
const FiscalIntegrationController = () =>
  import('#modules/sales/http/fiscal_integration_controller')
const IntegrationsController = () => import('#modules/inventory/http/integrations_controller')
const StockDocumentsController = () => import('#modules/inventory/http/stock_documents_controller')

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
                router.get('leave/types', [LeaveController, 'types'])
                router
                  .post('leave/types', [LeaveController, 'createType'])
                  .use(middleware.can({ permission: 'hr.leave.settings' }))
                router
                  .patch('leave/types/:id', [LeaveController, 'updateType'])
                  .use(middleware.can({ permission: 'hr.leave.settings' }))
                router
                  .get('leave/policies', [LeaveController, 'policies'])
                  .use(middleware.can({ permission: 'hr.leave.settings' }))
                router
                  .post('leave/policies', [LeaveController, 'createPolicy'])
                  .use(middleware.can({ permission: 'hr.leave.settings' }))
                router
                  .get('leave/policies/:id', [LeaveController, 'policy'])
                  .use(middleware.can({ permission: 'hr.leave.settings' }))
                router
                  .patch('leave/policies/:id', [LeaveController, 'updatePolicy'])
                  .use(middleware.can({ permission: 'hr.leave.settings' }))
                router
                  .post('leave/policies/:id/publish', [LeaveController, 'publishPolicy'])
                  .use(middleware.can({ permission: 'hr.leave.settings' }))
                router.post('leave/accruals', [LeaveController, 'accrue'])
                router.get('leave/me', [LeaveController, 'mine'])
                router.get('employees/:id/leave', [LeaveController, 'summary'])
                router.post('employees/:id/leave/adjustments', [LeaveController, 'adjust'])
                router.get('leave/requests', [LeaveController, 'requests'])
                router.post('leave/requests', [LeaveController, 'createRequest'])
                router.post('leave/requests/preview', [LeaveController, 'preview'])
                router.get('leave/requests/:id', [LeaveController, 'request'])
                router.post('leave/requests/:id/decision', [LeaveController, 'decide'])
                router.post('leave/requests/:id/cancel', [LeaveController, 'cancel'])
                router.get('pay-components', [CompensationController, 'components'])
                router
                  .post('pay-components', [CompensationController, 'createComponent'])
                  .use(middleware.can({ permission: 'hr.compensation.settings' }))
                router
                  .get('pay-components/:id', [CompensationController, 'component'])
                  .use(middleware.can({ permission: 'hr.compensation.settings' }))
                router
                  .patch('pay-components/:id', [CompensationController, 'updateComponent'])
                  .use(middleware.can({ permission: 'hr.compensation.settings' }))
                router
                  .post('pay-components/:id/incidences', [CompensationController, 'addIncidence'])
                  .use(middleware.can({ permission: 'hr.compensation.settings' }))
                router.get('employees/:id/compensation', [CompensationController, 'summary'])
                router.post('employees/:id/compensation/proposals', [
                  CompensationController,
                  'createProposal',
                ])
                router.get('compensation/proposals', [CompensationController, 'proposals'])
                router.get('compensation/proposals/:id', [CompensationController, 'proposal'])
                router.patch('compensation/proposals/:id', [
                  CompensationController,
                  'updateProposal',
                ])
                router.post('compensation/proposals/:id/submit', [CompensationController, 'submit'])
                router.post('compensation/proposals/:id/decision', [
                  CompensationController,
                  'decide',
                ])
                router.post('compensation/proposals/:id/cancel', [CompensationController, 'cancel'])
                router.get('employees/:id/loans', [LoansController, 'forEmployee'])
                router.post('employees/:id/loans', [LoansController, 'store'])
                router.get('loans', [LoansController, 'index'])
                router.get('loans/:id', [LoansController, 'show'])
                router.patch('loans/:id', [LoansController, 'update'])
                router.post('loans/:id/submit', [LoansController, 'submit'])
                router.post('loans/:id/decision', [LoansController, 'decide'])
                router.post('loans/:id/cancel', [LoansController, 'cancel'])
                router.post('loans/:id/installments/:installmentId/payment', [
                  LoansController,
                  'pay',
                ])
                router
                  .get('payroll/rule-sets', [PayrollController, 'ruleSets'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router
                  .post('payroll/rule-sets', [PayrollController, 'createRuleSet'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router
                  .get('payroll/rule-sets/:id', [PayrollController, 'ruleSet'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router
                  .patch('payroll/rule-sets/:id', [PayrollController, 'updateRuleSet'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router
                  .post('payroll/rule-sets/:id/publish', [PayrollController, 'publishRuleSet'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router
                  .post('payroll/rule-sets/:id/verify', [PayrollController, 'verifyRuleSet'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router
                  .post('payroll/rule-sets/:id/simulate', [PayrollController, 'simulateRuleSet'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router
                  .post('payroll/rule-sets/:id/confirm', [PayrollController, 'confirmRuleSet'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router
                  .delete('payroll/rule-sets/:id', [PayrollController, 'deleteRuleSet'])
                  .use(middleware.can({ permission: 'hr.payroll.settings' }))
                router.get('payroll/periods', [PayrollController, 'periods'])
                router.get('payroll/runs', [PayrollController, 'index'])
                router.post('payroll/runs', [PayrollController, 'store'])
                router.get('payroll/runs/:id', [PayrollController, 'show'])
                router.get('payroll/runs/:id/results/:resultId', [PayrollController, 'result'])
                router.put('payroll/runs/:id/inputs', [PayrollController, 'setInput'])
                router.post('payroll/runs/:id/exclusions', [PayrollController, 'setExcluded'])
                router.post('payroll/runs/:id/calculate', [PayrollController, 'calculate'])
                router.post('payroll/runs/:id/submit', [PayrollController, 'submit'])
                router.post('payroll/runs/:id/decision', [PayrollController, 'decide'])
                router.post('payroll/runs/:id/close', [PayrollController, 'close'])
                router.post('payroll/runs/:id/cancel', [PayrollController, 'cancel'])
                router.get('payroll/runs/:id/payments', [PayrollController, 'payments'])
                router.post('payroll/obligations/:id/payments', [PayrollController, 'pay'])
                router.post('payroll/runs/:id/accounting', [PayrollController, 'account'])
                router.get('payslips', [PayrollController, 'myPayslips'])
                router.get('payslips/:id', [PayrollController, 'payslip'])
                router
                  .post('training/competencies', [TrainingController, 'createCompetency'])
                  .use(middleware.can({ permission: 'hr.training.settings' }))
                router
                  .patch('training/competencies/:id', [TrainingController, 'updateCompetency'])
                  .use(middleware.can({ permission: 'hr.training.settings' }))
                router
                  .post('training/courses', [TrainingController, 'createCourse'])
                  .use(middleware.can({ permission: 'hr.training.settings' }))
                router
                  .patch('training/courses/:id', [TrainingController, 'updateCourse'])
                  .use(middleware.can({ permission: 'hr.training.settings' }))
                router.get('training/competencies', [TrainingController, 'competencies'])
                router.get('training/courses', [TrainingController, 'courses'])
                router.get('training/sessions', [TrainingController, 'sessions'])
                router.post('training/sessions', [TrainingController, 'createSession'])
                router.get('training/sessions/:id', [TrainingController, 'session'])
                router.post('training/sessions/:id/enrollments', [TrainingController, 'enroll'])
                router.post('training/sessions/:id/complete', [TrainingController, 'complete'])
                router.post('training/sessions/:id/cancel', [TrainingController, 'cancelSession'])
                router.post('training/enrollments/:id/result', [TrainingController, 'result'])
                router.get('training/costs', [TrainingController, 'costs'])
                router.get('employees/:id/training', [TrainingController, 'employeeTraining'])
                router.post('employees/:id/competencies', [TrainingController, 'assess'])
                router.post('employees/:id/certificates', [TrainingController, 'addCertificate'])
                router.get('discipline/cases', [TrainingController, 'cases'])
                router.get('discipline/cases/:id', [TrainingController, 'case'])
                router.post('employees/:id/discipline/cases', [TrainingController, 'openCase'])
                router.post('discipline/cases/:id/events', [TrainingController, 'caseEvent'])
                router.post('discipline/cases/:id/review', [TrainingController, 'reviewCase'])
                router.post('discipline/cases/:id/close', [TrainingController, 'closeCase'])
                router.get('me', [PortalController, 'me'])
                router.patch('me', [PortalController, 'updateMe'])
                router.get('team', [PortalController, 'team'])
                router.get('reports/headcount', [PortalController, 'headcount'])
                router.get('reports/turnover', [PortalController, 'turnover'])
                router.get('reports/leave', [PortalController, 'leave'])
                router.get('reports/payroll', [PortalController, 'payroll'])
                router.get('terminations', [TerminationsController, 'index'])
                router.get('terminations/:id', [TerminationsController, 'show'])
                router.post('employees/:id/terminations', [TerminationsController, 'store'])
                router.patch('terminations/:id', [TerminationsController, 'update'])
                router.post('terminations/:id/lines', [TerminationsController, 'addLine'])
                router.patch('terminations/:id/lines/:lineId', [
                  TerminationsController,
                  'updateLine',
                ])
                router.delete('terminations/:id/lines/:lineId', [
                  TerminationsController,
                  'removeLine',
                ])
                router.post('terminations/:id/submit', [TerminationsController, 'submit'])
                router.post('terminations/:id/decision', [TerminationsController, 'decide'])
                router.post('terminations/:id/cancel', [TerminationsController, 'cancel'])
                router.post('terminations/:id/settlement', [TerminationsController, 'settlement'])
                router.post('terminations/:id/complete', [TerminationsController, 'complete'])
                router.post('terminations/:id/tasks', [TerminationsController, 'addTask'])
                router.patch('termination-tasks/:id', [TerminationsController, 'setTask'])
                router.get('employees/:id/contracts', [CareerController, 'contracts'])
                router.post('employees/:id/contracts', [CareerController, 'createContract'])
                router.get('employees/:id/assignments', [CareerController, 'assignments'])
                router.post('employees/:id/assignments', [CareerController, 'move'])
                router.get('contracts/:id', [CareerController, 'contract'])
                router.patch('contracts/:id', [CareerController, 'updateContract'])
                router.post('contracts/:id/activate', [CareerController, 'activate'])
                router.post('contracts/:id/suspend', [CareerController, 'suspend'])
                router.post('contracts/:id/resume', [CareerController, 'resume'])
                router.post('contracts/:id/terminate', [CareerController, 'terminate'])
                router.post('contracts/:id/cancel', [CareerController, 'cancel'])
                router.post('contracts/:id/amendments', [CareerController, 'amend'])
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

            router
              .group(() => {
                router
                  .get('products', [CatalogController, 'index'])
                  .use(middleware.can({ permission: 'inventory.read' }))
                router
                  .get('products/lookup', [CatalogController, 'lookup'])
                  .use(middleware.can({ permission: 'inventory.read' }))
                router
                  .get('products/:id', [CatalogController, 'show'])
                  .use(middleware.can({ permission: 'inventory.read' }))
                router
                  .post('products', [CatalogController, 'store'])
                  .use(middleware.can({ permission: 'inventory.products.manage' }))
                router
                  .patch('products/:id', [CatalogController, 'update'])
                  .use(middleware.can({ permission: 'inventory.products.manage' }))
                router
                  .post('products/:id/variants', [CatalogController, 'storeVariant'])
                  .use(middleware.can({ permission: 'inventory.products.manage' }))
                router
                  .patch('product-variants/:id', [CatalogController, 'updateVariant'])
                  .use(middleware.can({ permission: 'inventory.products.manage' }))
                router
                  .get('settings/:kind', [CatalogController, 'settingsList'])
                  .use(middleware.can({ permission: 'inventory.read' }))
                router
                  .post('settings/:kind', [CatalogController, 'settingsCreate'])
                  .use(middleware.can({ permission: 'inventory.settings' }))
                router
                  .patch('settings/:kind/:id', [CatalogController, 'settingsUpdate'])
                  .use(middleware.can({ permission: 'inventory.settings' }))
                router.get('warehouses', [WarehousesController, 'index'])
                router.get('warehouses/candidates', [WarehousesController, 'candidates'])
                router.get('warehouses/:id', [WarehousesController, 'show'])
                router.post('warehouses', [WarehousesController, 'store'])
                router.patch('warehouses/:id', [WarehousesController, 'update'])
                router.post('warehouses/:id/locations', [WarehousesController, 'addLocations'])
                router.patch('warehouse-locations/:id', [WarehousesController, 'updateLocation'])
                router.put('warehouses/:id/access', [WarehousesController, 'setAccess'])
                router.get('stock/balances', [StockController, 'balances'])
                router.get('stock/movements', [StockController, 'movements'])
                router.get('stock/postings/:id', [StockController, 'posting'])
                router.get('stock/reconciliation', [StockController, 'reconciliation'])
                router.post('stock/status-changes', [StockController, 'changeStatus'])
                router.get('documents', [StockDocumentsController, 'index'])
                router.post('documents', [StockDocumentsController, 'store'])
                router.get('documents/:id', [StockDocumentsController, 'show'])
                router.put('documents/:id', [StockDocumentsController, 'update'])
                router.post('documents/:id/check', [StockDocumentsController, 'check'])
                router.post('documents/:id/reopen', [StockDocumentsController, 'reopen'])
                router.post('documents/:id/confirm', [StockDocumentsController, 'confirm'])
                router.post('documents/:id/close', [StockDocumentsController, 'close'])
                router.post('documents/:id/cancel', [StockDocumentsController, 'cancel'])
                router.post('document-confirmations/:id/reverse', [
                  StockDocumentsController,
                  'reverse',
                ])
                router.get('transfers', [TransfersController, 'index'])
                router.post('transfers', [TransfersController, 'store'])
                router.get('transfers/destinations', [TransfersController, 'destinations'])
                router.get('transfers/:id', [TransfersController, 'show'])
                router.put('transfers/:id', [TransfersController, 'update'])
                router.post('transfers/:id/submit', [TransfersController, 'submit'])
                router.post('transfers/:id/approve', [TransfersController, 'approve'])
                router.post('transfers/:id/accept', [TransfersController, 'accept'])
                router.post('transfers/:id/reject', [TransfersController, 'reject'])
                router.post('transfers/:id/pick', [TransfersController, 'pick'])
                router.post('transfers/:id/dispatch', [TransfersController, 'dispatch'])
                router.post('transfers/:id/receive', [TransfersController, 'receive'])
                router.post('transfers/:id/close', [TransfersController, 'close'])
                router.post('transfers/:id/cancel', [TransfersController, 'cancel'])
                router.get('requisitions', [RequisitionsController, 'index'])
                router.get('requisitions/options', [RequisitionsController, 'options'])
                router.post('requisitions', [RequisitionsController, 'store'])
                router.get('requisitions/:id', [RequisitionsController, 'show'])
                router.put('requisitions/:id', [RequisitionsController, 'update'])
                router.post('requisitions/:id/submit', [RequisitionsController, 'submit'])
                router.post('requisitions/:id/approve', [RequisitionsController, 'approve'])
                router.post('requisitions/:id/reject', [RequisitionsController, 'reject'])
                router.post('requisitions/:id/pick', [RequisitionsController, 'pick'])
                router.post('requisitions/:id/issue', [RequisitionsController, 'issue'])
                router.post('requisitions/:id/release', [RequisitionsController, 'release'])
                router.post('requisitions/:id/cancel', [RequisitionsController, 'cancel'])
                router.get('reservations', [RequisitionsController, 'reservations'])
                router.get('counts', [CountsController, 'index'])
                router.get('counts/options', [CountsController, 'options'])
                router.post('counts', [CountsController, 'store'])
                router.get('counts/:id', [CountsController, 'show'])
                router.put('counts/:id', [CountsController, 'update'])
                router.post('counts/:id/start', [CountsController, 'start'])
                router.post('counts/:id/count', [CountsController, 'count'])
                router.post('counts/:id/lines', [CountsController, 'addLine'])
                router.post('counts/:id/submit', [CountsController, 'submit'])
                router.post('counts/:id/justify', [CountsController, 'justify'])
                router.post('counts/:id/recount', [CountsController, 'recount'])
                router.post('counts/:id/approve', [CountsController, 'approve'])
                router.post('counts/:id/cancel', [CountsController, 'cancel'])
                router.get('lots', [LotsController, 'index'])
                router.get('lots/:id', [LotsController, 'show'])
                router.post('lots/:id/block', [LotsController, 'block'])
                router.post('lots/:id/unblock', [LotsController, 'unblock'])
                router.post('lots/:id/recall', [LotsController, 'recall'])
                router.get('serials', [LotsController, 'serials'])
                router.get('serials/:id', [LotsController, 'serial'])
                router.get('valuation', [ValuationController, 'index'])
                router.get('valuation/products/:id', [ValuationController, 'product'])
                router.post('valuation/adjustments', [ValuationController, 'adjust'])
                router.get('valuation/reconciliation', [ValuationController, 'reconciliation'])
                router.get('valuation/accounts', [ValuationController, 'accounts'])
                router.put('valuation/accounts', [ValuationController, 'setAccounts'])
                router.get('integrations/events', [IntegrationsController, 'index'])
                router.get('integrations/sales-orders', [IntegrationsController, 'order'])
                router.post('integrations/:kind', [IntegrationsController, 'post'])
                router.get('accounting-events', [IntegrationsController, 'accountingEvents'])
                router.post('accounting-events/retry', [IntegrationsController, 'retry'])
                router.get('reports/alerts', [InventoryReportsController, 'alerts'])
                router.get('reports/replenishment', [InventoryReportsController, 'replenishment'])
                router.get('reports/expiry', [InventoryReportsController, 'expiry'])
                router.get('reports/turnover', [InventoryReportsController, 'turnover'])
                router.get('reports/movements', [InventoryReportsController, 'movements'])
                router.get('reports/losses', [InventoryReportsController, 'losses'])
                router.get('reports/consumption', [InventoryReportsController, 'consumption'])
                router.get('reports/valued', [InventoryReportsController, 'valued'])
              })
              .prefix('inventory')
              .use(middleware.entitled({ feature: 'inventory' }))

            // Compras (Prompt 09): fornecedores. Permissões verificadas no serviço (ver routes_protection).
            router
              .group(() => {
                router.get('suppliers', [SuppliersController, 'index'])
                router.get('suppliers/lookup', [SuppliersController, 'lookup'])
                router.post('suppliers', [SuppliersController, 'store'])
                router.get('suppliers/:id', [SuppliersController, 'show'])
                router.patch('suppliers/:id', [SuppliersController, 'update'])
                router.post('suppliers/:id/contacts', [SuppliersController, 'addContact'])
                router.patch('suppliers/:id/contacts/:contactId', [
                  SuppliersController,
                  'updateContact',
                ])
                router.post('suppliers/:id/bank-accounts', [SuppliersController, 'addBankAccount'])
                router.post('supplier-bank-accounts/:id/:action', [
                  SuppliersController,
                  'bankAccountAction',
                ])
                router.post('suppliers/:id/documents', [SuppliersController, 'addDocument'])
                router.post('supplier-documents/:id/deactivate', [
                  SuppliersController,
                  'deactivateDocument',
                ])
                router.post('suppliers/:id/submit', [SuppliersController, 'submit'])
                router.post('suppliers/:id/approve', [SuppliersController, 'approve'])
                router.post('suppliers/:id/reject', [SuppliersController, 'reject'])
                router.post('suppliers/:id/suspend', [SuppliersController, 'suspend'])
                router.get('requisitions', [PurchaseRequisitionsController, 'index'])
                router.get('requisitions/options', [PurchaseRequisitionsController, 'options'])
                router.get('requisitions/demand', [PurchaseRequisitionsController, 'demand'])
                router.post('requisitions', [PurchaseRequisitionsController, 'store'])
                router.get('requisitions/:id', [PurchaseRequisitionsController, 'show'])
                router.put('requisitions/:id', [PurchaseRequisitionsController, 'update'])
                router.post('requisitions/:id/submit', [PurchaseRequisitionsController, 'submit'])
                router.post('requisitions/:id/approve', [PurchaseRequisitionsController, 'approve'])
                router.post('requisitions/:id/reject', [PurchaseRequisitionsController, 'reject'])
                router.post('requisitions/:id/cancel', [PurchaseRequisitionsController, 'cancel'])
                router.post('requisitions/:id/close', [PurchaseRequisitionsController, 'close'])
                router.post('requisitions/:id/copy', [PurchaseRequisitionsController, 'copy'])
                router.get('rfqs', [RfqsController, 'index'])
                router.get('rfqs/options', [RfqsController, 'options'])
                router.post('rfqs', [RfqsController, 'store'])
                router.get('rfqs/:id', [RfqsController, 'show'])
                router.put('rfqs/:id', [RfqsController, 'update'])
                router.post('rfqs/:id/invitations', [RfqsController, 'invite'])
                router.post('rfqs/:id/issue', [RfqsController, 'issue'])
                router.post('rfqs/:id/amend', [RfqsController, 'amend'])
                router.post('rfqs/:id/quotes', [RfqsController, 'quote'])
                router.post('rfqs/:id/open', [RfqsController, 'open'])
                router.post('rfqs/:id/cancel', [RfqsController, 'cancel'])
                router.post('rfqs/:id/comparison', [RfqsController, 'compare'])
                router.post('rfqs/:id/awards', [RfqsController, 'createAward'])
                router.get('rfq-awards/:id', [RfqsController, 'award'])
                router.put('rfq-awards/:id', [RfqsController, 'updateAward'])
                router.post('rfq-awards/:id/submit', [RfqsController, 'submitAward'])
                router.post('rfq-awards/:id/approve', [RfqsController, 'approveAward'])
                router.post('rfq-awards/:id/reject', [RfqsController, 'rejectAward'])
                router.post('rfq-awards/:id/cancel', [RfqsController, 'cancelAward'])
                router.delete('rfq-invitations/:id', [RfqsController, 'uninvite'])
                router.post('rfq-invitations/:id/decline', [RfqsController, 'decline'])
                router.post('rfq-quotes/:id/withdraw', [RfqsController, 'withdraw'])
                router.get('orders', [PurchaseOrdersController, 'index'])
                router.get('orders/options', [PurchaseOrdersController, 'options'])
                router.post('orders', [PurchaseOrdersController, 'store'])
                router.post('rfq-awards/:id/orders', [PurchaseOrdersController, 'fromAward'])
                router.get('orders/:id', [PurchaseOrdersController, 'show'])
                router.put('orders/:id', [PurchaseOrdersController, 'update'])
                router.post('orders/:id/submit', [PurchaseOrdersController, 'submit'])
                router.post('orders/:id/approve', [PurchaseOrdersController, 'approve'])
                router.post('orders/:id/reject', [PurchaseOrdersController, 'reject'])
                router.post('orders/:id/issue', [PurchaseOrdersController, 'issue'])
                router.post('orders/:id/revise', [PurchaseOrdersController, 'revise'])
                router.post('orders/:id/cancel', [PurchaseOrdersController, 'cancel'])
                router.post('orders/:id/close', [PurchaseOrdersController, 'close'])
                router.get('contracts', [ContractsController, 'index'])
                router.get('contracts/options', [ContractsController, 'options'])
                router.post('contracts', [ContractsController, 'store'])
                router.get('contracts/:id', [ContractsController, 'show'])
                router.put('contracts/:id', [ContractsController, 'update'])
                router.post('contracts/:id/submit', [ContractsController, 'submit'])
                router.post('contracts/:id/approve', [ContractsController, 'approve'])
                router.post('contracts/:id/reject', [ContractsController, 'reject'])
                router.post('contracts/:id/amendments', [ContractsController, 'propose'])
                router.post('contracts/:id/:action', [ContractsController, 'transition'])
                router.post('contract-amendments/:id/:action', [ContractsController, 'amendment'])
                router.get('receipts', [ReceiptsController, 'index'])
                router.get('receipts/expected', [ReceiptsController, 'expected'])
                router.get('receipts/orders/:id', [ReceiptsController, 'order'])
                router.post('receipts', [ReceiptsController, 'store'])
                router.get('receipts/:id', [ReceiptsController, 'show'])
                router.put('receipts/:id', [ReceiptsController, 'update'])
                router.post('receipts/:id/confirm', [ReceiptsController, 'confirm'])
                router.post('receipts/:id/cancel', [ReceiptsController, 'cancel'])
                router.post('receipts/:id/reverse', [ReceiptsController, 'reverse'])
                router.get('invoices', [InvoicesController, 'index'])
                router.get('invoices/orders/:id', [InvoicesController, 'order'])
                router.post('invoices', [InvoicesController, 'store'])
                router.get('invoices/:id', [InvoicesController, 'show'])
                router.put('invoices/:id', [InvoicesController, 'update'])
                router.post('invoices/:id/validate', [InvoicesController, 'validate'])
                router.post('invoices/:id/approve', [InvoicesController, 'approve'])
                router.post('invoices/:id/reject', [InvoicesController, 'reject'])
                router.post('invoices/:id/refuse', [InvoicesController, 'refuse'])
                router.post('invoices/:id/cancel', [InvoicesController, 'cancel'])
                router.get('returns', [ReturnsController, 'index'])
                router.get('returns/receipts/:id', [ReturnsController, 'receipt'])
                router.post('returns', [ReturnsController, 'store'])
                router.get('returns/:id', [ReturnsController, 'show'])
                router.put('returns/:id', [ReturnsController, 'update'])
                router.post('returns/:id/confirm', [ReturnsController, 'confirm'])
                router.post('returns/:id/cancel', [ReturnsController, 'cancel'])
                router.get('credit-notes', [CreditNotesController, 'index'])
                router.get('credit-notes/invoices/:id', [CreditNotesController, 'invoice'])
                router.post('credit-notes', [CreditNotesController, 'store'])
                router.get('credit-notes/:id', [CreditNotesController, 'show'])
                router.put('credit-notes/:id', [CreditNotesController, 'update'])
                router.post('credit-notes/:id/validate', [CreditNotesController, 'validate'])
                router.post('credit-notes/:id/cancel', [CreditNotesController, 'cancel'])
                router.get('budgets', [ProcurementFinanceController, 'budgets'])
                router.get('budgets/options', [ProcurementFinanceController, 'budgetOptions'])
                router.post('budgets', [ProcurementFinanceController, 'createBudget'])
                router.get('budgets/:id', [ProcurementFinanceController, 'budget'])
                router.put('budgets/:id', [ProcurementFinanceController, 'updateBudget'])
                router.get('payables', [ProcurementFinanceController, 'payables'])
                router.get('payables/:id', [ProcurementFinanceController, 'payable'])
                router.post('payables/:id/payments', [ProcurementFinanceController, 'pay'])
                router.post('payables/:id/accounting/retry', [
                  ProcurementFinanceController,
                  'retry',
                ])
                router.get('evaluations/weights', [EvaluationsController, 'weights'])
                router
                  .put('evaluations/weights', [EvaluationsController, 'setWeights'])
                  .use(middleware.can({ permission: 'procurement.settings' }))
                router.get('evaluations/ranking', [EvaluationsController, 'ranking'])
                router.get('evaluations/suppliers/:id', [EvaluationsController, 'supplier'])
                router.post('evaluations/suppliers/:id', [EvaluationsController, 'publish'])
                router.get('evaluations/:id', [EvaluationsController, 'show'])
                router.get('tolerances', [InvoicesController, 'tolerances'])
                router
                  .put('tolerances', [InvoicesController, 'setTolerances'])
                  .use(middleware.can({ permission: 'procurement.settings' }))
                router.get('approval-levels', [PurchaseRequisitionsController, 'levels'])
                router
                  .post('approval-levels', [PurchaseRequisitionsController, 'createLevel'])
                  .use(middleware.can({ permission: 'procurement.settings' }))
                router
                  .patch('approval-levels/:id', [PurchaseRequisitionsController, 'updateLevel'])
                  .use(middleware.can({ permission: 'procurement.settings' }))
                router.get('settings/:kind', [SuppliersController, 'settingsIndex'])
                router
                  .post('settings/:kind', [SuppliersController, 'settingsStore'])
                  .use(middleware.can({ permission: 'procurement.settings' }))
                router
                  .patch('settings/:kind/:id', [SuppliersController, 'settingsUpdate'])
                  .use(middleware.can({ permission: 'procurement.settings' }))
              })
              .prefix('procurement')
              .use(middleware.entitled({ feature: 'procurement' }))

            // Vendas e Facturação (Prompt 10): clientes. Permissões verificadas no serviço (ver routes_protection).
            router
              .group(() => {
                router.get('customers', [CustomersController, 'index'])
                router.get('customers/lookup', [CustomersController, 'lookup'])
                router.post('customers', [CustomersController, 'store'])
                router.get('customers/:id', [CustomersController, 'show'])
                router.patch('customers/:id', [CustomersController, 'update'])
                router.post('customers/:id/credit', [CustomersController, 'credit'])
                router.post('customers/:id/status', [CustomersController, 'status'])
                router.post('customers/:id/addresses', [CustomersController, 'addAddress'])
                router.patch('customers/:id/addresses/:addressId', [
                  CustomersController,
                  'updateAddress',
                ])
                router.post('customers/:id/contacts', [CustomersController, 'addContact'])
                router.patch('customers/:id/contacts/:contactId', [
                  CustomersController,
                  'updateContact',
                ])
                router.get('customers/:id/current-version', [CustomersController, 'currentVersion'])
                router.get('segments', [CustomersController, 'segments'])
                router
                  .post('segments', [CustomersController, 'createSegment'])
                  .use(middleware.can({ permission: 'sales.settings' }))
                router
                  .patch('segments/:id', [CustomersController, 'updateSegment'])
                  .use(middleware.can({ permission: 'sales.settings' }))
                router.get('price-lists', [PricingController, 'lists'])
                router.post('price-lists', [PricingController, 'createList'])
                router.get('price-lists/:id', [PricingController, 'showList'])
                router.patch('price-lists/:id', [PricingController, 'updateList'])
                router.post('price-lists/:id/lines', [PricingController, 'addLine'])
                router.patch('price-lists/:id/lines/:lineId', [PricingController, 'updateLine'])
                router.delete('price-lists/:id/lines/:lineId', [PricingController, 'removeLine'])
                router.post('price-lists/:id/copy', [PricingController, 'copyList'])
                router.post('price-lists/:id/submit', [PricingController, 'submitList'])
                router.post('price-lists/:id/approve', [PricingController, 'approveList'])
                router.post('price-lists/:id/reject', [PricingController, 'rejectList'])
                router.post('price-lists/:id/deactivate', [PricingController, 'deactivateList'])
                router.get('discount-rules', [PricingController, 'rules'])
                router.post('discount-rules', [PricingController, 'createRule'])
                router.get('discount-rules/:id', [PricingController, 'showRule'])
                router.patch('discount-rules/:id', [PricingController, 'updateRule'])
                router.post('discount-rules/:id/submit', [PricingController, 'submitRule'])
                router.post('discount-rules/:id/approve', [PricingController, 'approveRule'])
                router.post('discount-rules/:id/reject', [PricingController, 'rejectRule'])
                router.post('discount-rules/:id/deactivate', [PricingController, 'deactivateRule'])
                router.get('discount-limits', [PricingController, 'limits'])
                router.put('discount-limits', [PricingController, 'setLimit'])
                router.delete('discount-limits/:id', [PricingController, 'removeLimit'])
                router.post('pricing/resolve', [PricingController, 'resolve'])
                router.get('pricing/options', [PricingController, 'options'])
                router.get('fiscal/tax-codes', [FiscalController, 'codes'])
                router.post('fiscal/tax-codes', [FiscalController, 'createCode'])
                router.get('fiscal/tax-codes/:id', [FiscalController, 'code'])
                router.patch('fiscal/tax-codes/:id', [FiscalController, 'updateCode'])
                router.post('fiscal/tax-codes/:id/rates', [FiscalController, 'addRate'])
                router.patch('fiscal/tax-rates/:id', [FiscalController, 'updateRate'])
                router.delete('fiscal/tax-rates/:id', [FiscalController, 'deleteRate'])
                router.post('fiscal/tax-rates/:id/confirm', [FiscalController, 'confirmRate'])
                router.post('fiscal/tax-rates/:id/retire', [FiscalController, 'retireRate'])
                router.get('fiscal/exemptions', [FiscalController, 'exemptions'])
                router.post('fiscal/exemptions', [FiscalController, 'createExemption'])
                router.patch('fiscal/exemptions/:id', [FiscalController, 'updateExemption'])
                router.post('fiscal/exemptions/:id/confirm', [FiscalController, 'confirmExemption'])
                router.post('fiscal/exemptions/:id/retire', [FiscalController, 'retireExemption'])
                router.get('fiscal/settings', [FiscalController, 'settings'])
                router.put('fiscal/settings/:legalEntityId', [FiscalController, 'setRounding'])
                router.get('fiscal/series', [FiscalController, 'series'])
                router.post('fiscal/series', [FiscalController, 'createSeries'])
                router.get('fiscal/series/:id/numbers', [FiscalController, 'seriesNumbers'])
                router.patch('fiscal/series/:id', [FiscalController, 'updateSeries'])
                router.post('fiscal/series/:id/activate', [FiscalController, 'activateSeries'])
                router.post('fiscal/series/:id/close', [FiscalController, 'closeSeries'])
                router.post('fiscal/simulate', [FiscalController, 'simulate'])
                router.get('fiscal/integration', [FiscalIntegrationController, 'settings'])
                router.put('fiscal/integration/:legalEntityId', [
                  FiscalIntegrationController,
                  'updateSettings',
                ])
                router.post('fiscal/integration/:legalEntityId/contingency', [
                  FiscalIntegrationController,
                  'contingency',
                ])
                router.get('fiscal/submissions', [FiscalIntegrationController, 'index'])
                router.post('fiscal/submissions/process', [
                  FiscalIntegrationController,
                  'processQueue',
                ])
                router.get('fiscal/submissions/document/:type/:documentId', [
                  FiscalIntegrationController,
                  'forDocument',
                ])
                router.get('fiscal/submissions/:id', [FiscalIntegrationController, 'show'])
                router.post('fiscal/submissions/:id/process', [
                  FiscalIntegrationController,
                  'processOne',
                ])
                router.post('fiscal/submissions/:id/requeue', [
                  FiscalIntegrationController,
                  'requeue',
                ])
                router.get('invoices', [SalesInvoicesController, 'index'])
                router.get('invoices/options', [SalesInvoicesController, 'options'])
                router.get('invoices/search/customers', [
                  SalesInvoicesController,
                  'searchCustomers',
                ])
                router.get('invoices/search/products', [SalesInvoicesController, 'searchProducts'])
                router.get('invoices/order-draft/:orderId', [SalesInvoicesController, 'orderDraft'])
                router.post('invoices', [SalesInvoicesController, 'store'])
                router.get('invoices/:id', [SalesInvoicesController, 'show'])
                router.patch('invoices/:id', [SalesInvoicesController, 'update'])
                router.post('invoices/:id/issue', [SalesInvoicesController, 'issue'])
                router.post('invoices/:id/discard', [SalesInvoicesController, 'discard'])
                router.get('receipts', [SalesReceiptsController, 'index'])
                router.get('receipts/options', [SalesReceiptsController, 'options'])
                router.get('receipts/search/customers', [
                  SalesReceiptsController,
                  'searchCustomers',
                ])
                router.get('receipts/open-items/:legalEntityId/:customerId', [
                  SalesReceiptsController,
                  'openItems',
                ])
                router.post('receipts', [SalesReceiptsController, 'store'])
                router.get('receipts/:id', [SalesReceiptsController, 'show'])
                router.post('receipts/:id/confirm', [SalesReceiptsController, 'confirm'])
                router.post('receipts/:id/reject', [SalesReceiptsController, 'reject'])
                router.post('receipts/:id/cancel', [SalesReceiptsController, 'cancel'])
                router.post('receipts/:id/apply-advance', [SalesReceiptsController, 'applyAdvance'])
                router.get('recurring', [RecurringController, 'index'])
                router.get('recurring/options', [RecurringController, 'options'])
                router.get('recurring/search/customers', [RecurringController, 'searchCustomers'])
                router.get('recurring/search/products', [RecurringController, 'searchProducts'])
                router.post('recurring/generate', [RecurringController, 'generateAll'])
                router.post('recurring', [RecurringController, 'store'])
                router.get('recurring/:id', [RecurringController, 'show'])
                router.patch('recurring/:id', [RecurringController, 'update'])
                router.post('recurring/:id/versions', [RecurringController, 'addVersion'])
                router.post('recurring/:id/activate', [RecurringController, 'activate'])
                router.post('recurring/:id/suspend', [RecurringController, 'suspend'])
                router.post('recurring/:id/resume', [RecurringController, 'resume'])
                router.post('recurring/:id/end', [RecurringController, 'end'])
                router.post('recurring/:id/generate', [RecurringController, 'generate'])
                router.patch('recurring-versions/:id', [RecurringController, 'updateVersion'])
                router.post('recurring-versions/:id/approve', [
                  RecurringController,
                  'approveVersion',
                ])
                router.post('recurring-versions/:id/discard', [
                  RecurringController,
                  'discardVersion',
                ])
                router.get('collections', [CollectionsController, 'index'])
                router.get('collections/:customerId', [CollectionsController, 'show'])
                router.post('collections/:customerId/promises', [
                  CollectionsController,
                  'storePromise',
                ])
                router.post('collections/:customerId/activities', [
                  CollectionsController,
                  'storeActivity',
                ])
                router.post('collection-promises/:id/cancel', [
                  CollectionsController,
                  'cancelPromise',
                ])
                router.get('notes', [SalesNotesController, 'index'])
                router.get('notes/options', [SalesNotesController, 'options'])
                router.get('notes/search/invoices', [SalesNotesController, 'searchInvoices'])
                router.get('notes/eligible/:invoiceId', [SalesNotesController, 'eligible'])
                router.post('notes', [SalesNotesController, 'store'])
                router.get('notes/:id', [SalesNotesController, 'show'])
                router.patch('notes/:id', [SalesNotesController, 'update'])
                router.post('notes/:id/issue', [SalesNotesController, 'issue'])
                router.post('notes/:id/discard', [SalesNotesController, 'discard'])
                router.post('notes/:id/apply-credit', [SalesNotesController, 'applyCredit'])
                router.post('notes/:id/refunds', [SalesNotesController, 'storeRefund'])
                router.post('refunds/:id/confirm', [SalesNotesController, 'confirmRefund'])
                router.post('refunds/:id/reject', [SalesNotesController, 'rejectRefund'])
                router.post('refunds/:id/cancel', [SalesNotesController, 'cancelRefund'])
                router.get('orders', [OrdersController, 'index'])
                router.get('orders/options', [OrdersController, 'options'])
                router.get('orders/addresses/:customerId', [OrdersController, 'addresses'])
                router.get('orders/search/customers', [OrdersController, 'searchCustomers'])
                router.get('orders/search/products', [OrdersController, 'searchProducts'])
                router.post('orders', [OrdersController, 'store'])
                router.post('orders/from-quote', [OrdersController, 'fromQuote'])
                router.get('orders/:id', [OrdersController, 'show'])
                router.patch('orders/:id', [OrdersController, 'update'])
                router.post('orders/:id/submit', [OrdersController, 'submit'])
                router.post('orders/:id/approve', [OrdersController, 'approve'])
                router.post('orders/:id/reject', [OrdersController, 'reject'])
                router.post('orders/:id/reserve', [OrdersController, 'reserve'])
                router.post('orders/:id/release', [OrdersController, 'release'])
                router.post('orders/:id/deliver', [OrdersController, 'deliver'])
                router.post('orders/:id/returns', [OrdersController, 'returnGoods'])
                router.post('orders/:id/close', [OrdersController, 'close'])
                router.post('orders/:id/cancel', [OrdersController, 'cancel'])
                router.get('quotes', [QuotesController, 'index'])
                router.get('quotes/options', [QuotesController, 'options'])
                router.get('quotes/search/customers', [QuotesController, 'searchCustomers'])
                router.get('quotes/search/products', [QuotesController, 'searchProducts'])
                router.post('quotes', [QuotesController, 'store'])
                router.get('quotes/:id', [QuotesController, 'show'])
                router.patch('quotes/:id', [QuotesController, 'update'])
                router.post('quotes/:id/submit', [QuotesController, 'submit'])
                router.post('quotes/:id/approve', [QuotesController, 'approve'])
                router.post('quotes/:id/reject', [QuotesController, 'reject'])
                router.post('quotes/:id/send', [QuotesController, 'send'])
                router.post('quotes/:id/accept', [QuotesController, 'accept'])
                router.post('quotes/:id/decline', [QuotesController, 'decline'])
                router.post('quotes/:id/revise', [QuotesController, 'revise'])
                router.post('quotes/:id/cancel', [QuotesController, 'cancel'])
                router.get('pricing/search/customers', [PricingController, 'searchCustomers'])
                router.get('pricing/search/products', [PricingController, 'searchProducts'])
              })
              .prefix('sales')
              .use(middleware.entitled({ feature: 'sales' }))

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
