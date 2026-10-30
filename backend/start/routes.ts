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
const OrganizationController = () =>
  import('#core/organization/presentation/organization_controller')
const MembersController = () => import('#core/members/presentation/members_controller')
const InvitationsController = () => import('#platform/tenants/presentation/invitations_controller')
const PartyController = () => import('#core/party/presentation/party_controller')
const AuditController = () => import('#core/audit/presentation/audit_controller')
const SubscriptionController = () =>
  import('#platform/billing/presentation/subscription_controller')
const ModulesController = () => import('#platform/modules/presentation/modules_controller')
const MetadataController = () => import('#dynamic/metadata/presentation/metadata_controller')
const RulesController = () => import('#dynamic/rules/presentation/rules_controller')
const FormsController = () => import('#dynamic/forms/presentation/forms_controller')
const StatesController = () => import('#dynamic/states/presentation/states_controller')
const CatalogController = () => import('#modules/catalog/presentation/catalog_controller')
const OrdersController = () => import('#modules/orders/presentation/orders_controller')
const ProcurementController = () =>
  import('#modules/procurement/presentation/procurement_controller')
const FinanceController = () => import('#modules/finance/presentation/finance_controller')
const NotificationsController = () =>
  import('#modules/notifications/presentation/notifications_controller')
const CalendarController = () => import('#modules/calendar/presentation/calendar_controller')
const ReportingController = () => import('#modules/reporting/presentation/reporting_controller')
const DocumentsController = () => import('#modules/documents/presentation/documents_controller')
const ProspectingController = () =>
  import('#modules/prospecting/presentation/prospecting_controller')
const InvoicingController = () => import('#modules/invoicing/presentation/invoicing_controller')
const LogisticsController = () => import('#modules/inventory/presentation/logistics_controller')
const InventoryController = () => import('#modules/inventory/presentation/inventory_controller')
const CustomersController = () => import('#modules/customers/presentation/customers_controller')
const AutomationsController = () =>
  import('#dynamic/automations/presentation/automations_controller')
const WorkflowsController = () => import('#dynamic/workflows/presentation/workflows_controller')
const SettingsController = () => import('#core/settings/presentation/settings_controller')
const PlatformController = () => import('#platform/administration/presentation/platform_controller')
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
        router.get('/me/security-events', [AuditController, 'myEvents'])
        router.post('/invitations/accept', [InvitationsController, 'accept'])
      })
      .use(middleware.auth())
  })
  .prefix('/api/v1')
  .use(middleware.origin())

/** Rotas de tenant: sessão + selector validado contra a membership activa. */
router
  .group(() => {
    router.get('/context', [ContextController, 'show'])
    router.get('/context/features', [ModulesController, 'features'])
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

/** Organização (C07) e âmbitos de acesso: leitura com `*.read`, escrita com `*.manage`. */
router
  .group(() => {
    router
      .group(() => {
        router.get('/organizations', [OrganizationController, 'listOrganizations'])
        router.get('/organizations/:id', [OrganizationController, 'showOrganization'])
        router.get('/organization-units', [OrganizationController, 'listUnits'])
        router.get('/organization-units/:id', [OrganizationController, 'showUnit'])
        router.get('/organization-units/:id/members', [OrganizationController, 'listTeam'])
        router.get('/cost-centers', [OrganizationController, 'listCostCenters'])
      })
      .use(middleware.can({ permission: 'organization.read' }))

    router
      .group(() => {
        router.post('/organizations', [OrganizationController, 'createOrganization'])
        router.patch('/organizations/:id', [OrganizationController, 'updateOrganization'])
        router.post('/organization-units', [OrganizationController, 'createUnit'])
        router.patch('/organization-units/:id', [OrganizationController, 'updateUnit'])
        router.post('/organization-units/:id/members', [OrganizationController, 'addTeamMember'])
        router.delete('/team-members/:id', [OrganizationController, 'removeTeamMember'])
        router.post('/cost-centers', [OrganizationController, 'createCostCenter'])
        router.patch('/cost-centers/:id', [OrganizationController, 'updateCostCenter'])
      })
      .use(middleware.can({ permission: 'organization.manage' }))

    router
      .get('/membership-scopes', [OrganizationController, 'listScopes'])
      .use(middleware.can({ permission: 'iam.read' }))
    router
      .group(() => {
        router.post('/membership-scopes', [OrganizationController, 'addScope'])
        router.delete('/membership-scopes/:id', [OrganizationController, 'removeScope'])
      })
      .use(middleware.can({ permission: 'iam.manage' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/** Membros e convites (C05): leitura `member.read`, convites `member.invite`, gestão `member.manage`. */
router
  .group(() => {
    router
      .group(() => {
        router.get('/memberships', [MembersController, 'listMembers'])
        router.get('/memberships/:id', [MembersController, 'showMember'])
        router.get('/invitations', [MembersController, 'listInvitations'])
      })
      .use(middleware.can({ permission: 'member.read' }))

    router
      .group(() => {
        router.post('/invitations', [MembersController, 'createInvitation'])
        router.post('/invitations/:id/revoke', [MembersController, 'revokeInvitation'])
      })
      .use(middleware.can({ permission: 'member.invite' }))

    router
      .patch('/memberships/:id', [MembersController, 'changeMemberStatus'])
      .use(middleware.can({ permission: 'member.manage' }))

    // O próprio membro (sem permissão extra): preferências e organização por omissão.
    router.get('/me/preferences', [MembersController, 'preferences'])
    router.put('/me/preferences/:key', [MembersController, 'setPreference'])
    router.delete('/me/preferences/:key', [MembersController, 'removePreference'])
    router.put('/me/default-organization', [MembersController, 'setDefaultOrganization'])
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/** Party (C08): ler `party.read`, criar `party.create`, alterar `party.update`; ligar a membro `member.manage`. */
router
  .group(() => {
    router
      .group(() => {
        router.get('/parties', [PartyController, 'list'])
        router.get('/parties/:id', [PartyController, 'show'])
        router.get('/parties/:id/possible-duplicates', [PartyController, 'duplicates'])
        router.get('/parties/:id/relationships', [PartyController, 'listRelationships'])
      })
      .use(middleware.can({ permission: 'party.read' }))

    router
      .group(() => {
        router.post('/people', [PartyController, 'createPerson'])
        router.post('/organization-parties', [PartyController, 'createOrganization'])
      })
      .use(middleware.can({ permission: 'party.create' }))

    router
      .group(() => {
        router.patch('/parties/:id', [PartyController, 'update'])
        router.post('/parties/:id/contacts', [PartyController, 'addContact'])
        router.patch('/contacts/:id', [PartyController, 'updateContact'])
        router.delete('/contacts/:id', [PartyController, 'removeContact'])
        router.post('/parties/:id/addresses', [PartyController, 'addAddress'])
        router.patch('/addresses/:id', [PartyController, 'updateAddress'])
        router.delete('/addresses/:id', [PartyController, 'removeAddress'])
        router.post('/parties/:id/relationships', [PartyController, 'addRelationship'])
        router.delete('/party-relationships/:id', [PartyController, 'removeRelationship'])
      })
      .use(middleware.can({ permission: 'party.update' }))

    router
      .put('/memberships/:id/person', [PartyController, 'linkMembership'])
      .use(middleware.can({ permission: 'member.manage' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/** Auditoria (S06): histórico de alterações e eventos de segurança do tenant, com `audit.read`. */
router
  .group(() => {
    router.get('/audit-logs', [AuditController, 'list'])
    router.get('/security-events', [AuditController, 'securityEvents'])
  })
  .prefix('/api/v1')
  .use([
    middleware.origin(),
    middleware.auth(),
    middleware.tenant(),
    middleware.can({ permission: 'audit.read' }),
  ])

/** Plano contratado pelo tenant (C02): leitura com `subscription.read`. A gestão de planos é do plano de controlo (comandos). */
router
  .group(() => {
    router.get('/tenant/subscription', [SubscriptionController, 'show'])
  })
  .prefix('/api/v1')
  .use([
    middleware.origin(),
    middleware.auth(),
    middleware.tenant(),
    middleware.can({ permission: 'subscription.read' }),
  ])

/** Registo de módulos (C03): catálogo com `module.read`; activar, desactivar e overrides com `module.manage`. */
router
  .group(() => {
    router
      .get('/modules', [ModulesController, 'list'])
      .use(middleware.can({ permission: 'module.read' }))
    router
      .group(() => {
        router.post('/tenant/modules/:code/enable', [ModulesController, 'enable'])
        router.post('/tenant/modules/:code/disable', [ModulesController, 'disable'])
        router.put('/tenant/features/:code', [ModulesController, 'setOverride'])
      })
      .use(middleware.can({ permission: 'module.manage' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Configurações, impostos, unidades e sequências (C09). Valores efectivos e preferências pessoais não exigem
 * permissão extra (cada um só altera o seu âmbito MEMBERSHIP); o resto: leitura `settings.read`, escrita
 * `settings.manage` e, para sequências, `sequence.manage`.
 */
router
  .group(() => {
    router.get('/settings/effective', [SettingsController, 'effective'])
    router.put('/me/settings/:key', [SettingsController, 'setPersonal'])
    router.delete('/me/settings/:key', [SettingsController, 'resetPersonal'])

    router
      .group(() => {
        router.get('/settings', [SettingsController, 'list'])
        router.get('/tax-rates', [SettingsController, 'listTaxRates'])
        router.get('/units', [SettingsController, 'listUnits'])
        router.get('/units/convert', [SettingsController, 'convert'])
        router.get('/sequences', [SettingsController, 'listSequences'])
      })
      .use(middleware.can({ permission: 'settings.read' }))

    router
      .group(() => {
        router.put('/settings/:key', [SettingsController, 'set'])
        router.delete('/settings/:key', [SettingsController, 'reset'])
        router.post('/tax-rates', [SettingsController, 'createTaxRate'])
        router.patch('/tax-rates/:id', [SettingsController, 'updateTaxRate'])
        router.post('/units', [SettingsController, 'createUnit'])
        router.patch('/units/:id', [SettingsController, 'updateUnit'])
      })
      .use(middleware.can({ permission: 'settings.manage' }))

    router
      .group(() => {
        router.post('/sequences', [SettingsController, 'createSequence'])
        router.patch('/sequences/:id', [SettingsController, 'updateSequence'])
        router.post('/sequences/preview', [SettingsController, 'previewSequence'])
      })
      .use(middleware.can({ permission: 'sequence.manage' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Metadados e entidades dinâmicas (C10). A definição exige `entity.*`; os registos exigem `dynamic.*` já à porta,
 * com o código da entidade como atributo do recurso (políticas ABAC por entidade), e o caso de uso volta a decidir
 * com os atributos do registo (unidade, responsável).
 */
router
  .group(() => {
    router
      .group(() => {
        router.get('/entity-definitions', [MetadataController, 'listEntities'])
        router.get('/entity-definitions/:id', [MetadataController, 'showEntity'])
        router.get('/entity-definitions/:id/publish-preview', [
          MetadataController,
          'previewPublish',
        ])
      })
      .use(middleware.can({ permission: 'entity.read' }))

    router
      .group(() => {
        router.post('/entity-definitions', [MetadataController, 'createEntity'])
        router.patch('/entity-definitions/:id', [MetadataController, 'updateEntity'])
        router.delete('/entity-definitions/:id', [MetadataController, 'deleteEntity'])
        router.put('/entity-definitions/:id/draft', [MetadataController, 'saveDraft'])
        router.post('/entity-definitions/:id/drafts', [MetadataController, 'createDraft'])
        router.delete('/entity-definitions/:id/draft', [MetadataController, 'discardDraft'])
      })
      .use(middleware.can({ permission: 'entity.design' }))

    router
      .group(() => {
        router.post('/entity-definitions/:id/publish', [MetadataController, 'publish'])
        router.post('/entity-definitions/:id/archive', [MetadataController, 'archiveEntity'])
      })
      .use(middleware.can({ permission: 'entity.publish' }))

    const onEntity = (permission: string) =>
      middleware.can({ permission, resource: { entity: 'entityCode' } })
    router
      .get('/dynamic/:entityCode/records', [MetadataController, 'listRecords'])
      .use(onEntity('dynamic.read'))
    router
      .get('/dynamic/:entityCode/records/:id', [MetadataController, 'showRecord'])
      .use(onEntity('dynamic.read'))
    router
      .post('/dynamic/:entityCode/records', [MetadataController, 'createRecord'])
      .use(onEntity('dynamic.create'))
    router
      .patch('/dynamic/:entityCode/records/:id', [MetadataController, 'updateRecord'])
      .use(onEntity('dynamic.update'))
    router
      .post('/dynamic/:entityCode/records/:id/archive', [MetadataController, 'archiveRecord'])
      .use(onEntity('dynamic.archive'))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Regras de negócio (C12): `rule.read` para ver e `rule.manage` para criar, simular, publicar e desactivar. As regras
 * publicadas bloqueiam as escritas de registos dinâmicos com a mensagem de negócio de cada uma.
 */
router
  .group(() => {
    router
      .group(() => {
        router.get('/rules', [RulesController, 'list'])
        router.get('/rules/:id', [RulesController, 'show'])
        router.get('/rules/:id/evaluations', [RulesController, 'evaluations'])
      })
      .use(middleware.can({ permission: 'rule.read' }))

    router
      .group(() => {
        router.post('/rules', [RulesController, 'create'])
        router.patch('/rules/:id', [RulesController, 'update'])
        router.post('/rules/:id/revisions', [RulesController, 'createRevision'])
        router.post('/rules/:id/simulate', [RulesController, 'simulate'])
        router.post('/rules/:id/publish', [RulesController, 'publish'])
        router.post('/rules/:id/disable', [RulesController, 'disable'])
      })
      .use(middleware.can({ permission: 'rule.manage' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Formulários (C11): `form.read` para ver, `form.design` para criar e alterar rascunhos e `form.publish` para publicar e
 * retirar. Quem lê os registos de uma entidade (`dynamic.read`) vê os formulários **publicados** dela, para os usar.
 */
router
  .group(() => {
    router
      .group(() => {
        router.get('/forms', [FormsController, 'list'])
        router.get('/forms/:id', [FormsController, 'show'])
        router.post('/forms/:id/preview', [FormsController, 'preview'])
      })
      .use(middleware.can({ permission: 'form.read' }))

    router
      .group(() => {
        router.post('/forms', [FormsController, 'create'])
        router.patch('/forms/:id', [FormsController, 'update'])
        router.post('/forms/:id/revisions', [FormsController, 'createRevision'])
      })
      .use(middleware.can({ permission: 'form.design' }))

    router
      .group(() => {
        router.post('/forms/:id/publish', [FormsController, 'publish'])
        router.post('/forms/:id/retire', [FormsController, 'retire'])
      })
      .use(middleware.can({ permission: 'form.publish' }))

    router
      .get('/dynamic/:entityCode/forms', [FormsController, 'published'])
      .use(middleware.can({ permission: 'dynamic.read', resource: { entity: 'entityCode' } }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Máquinas de estados (C13): `state.read` para ver, `state.design` para desenhar rascunhos e `state.publish` para publicar e
 * retirar. As transições executam-se com `dynamic.transition` (com o código da entidade como atributo, como os registos);
 * as acções disponíveis e o histórico exigem `dynamic.read`.
 */
router
  .group(() => {
    router
      .group(() => {
        router.get('/state-machines', [StatesController, 'list'])
        router.get('/state-machines/:id', [StatesController, 'show'])
        router.post('/state-machines/:id/preview', [StatesController, 'preview'])
      })
      .use(middleware.can({ permission: 'state.read' }))

    router
      .group(() => {
        router.post('/state-machines', [StatesController, 'create'])
        router.patch('/state-machines/:id', [StatesController, 'update'])
        router.post('/state-machines/:id/revisions', [StatesController, 'createRevision'])
      })
      .use(middleware.can({ permission: 'state.design' }))

    router
      .group(() => {
        router.post('/state-machines/:id/publish', [StatesController, 'publish'])
        router.post('/state-machines/:id/retire', [StatesController, 'retire'])
      })
      .use(middleware.can({ permission: 'state.publish' }))

    const onEntity = (permission: string) =>
      middleware.can({ permission, resource: { entity: 'entityCode' } })
    router
      .get('/dynamic/:entityCode/records/:id/available-actions', [
        StatesController,
        'availableActions',
      ])
      .use(onEntity('dynamic.read'))
    router
      .get('/dynamic/:entityCode/records/:id/state-history', [StatesController, 'history'])
      .use(onEntity('dynamic.read'))
    router
      .post('/dynamic/:entityCode/records/:id/transitions/:code', [StatesController, 'transition'])
      .use(onEntity('dynamic.transition'))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Workflows de aprovação (C14): `workflow.read` para ver, `workflow.design` para desenhar rascunhos e `workflow.publish` para
 * publicar e retirar. Submeter exige `workflow.submit` (com a entidade como atributo, verificada no caso de uso); a caixa
 * de aprovações e as decisões exigem `approval.decide`, e as delegações `approval.delegate`. Que processo ou tarefa cada
 * pessoa vê e decide é verificado no servidor, por tarefa (responsável, papel ou delegação em vigor).
 */
router
  .group(() => {
    router
      .group(() => {
        router.get('/workflows', [WorkflowsController, 'list'])
        router.get('/workflows/:id', [WorkflowsController, 'show'])
        router.post('/workflows/:id/preview', [WorkflowsController, 'preview'])
        router.get('/workflow-instances', [WorkflowsController, 'listInstances'])
      })
      .use(middleware.can({ permission: 'workflow.read' }))

    router
      .group(() => {
        router.post('/workflows', [WorkflowsController, 'create'])
        router.patch('/workflows/:id', [WorkflowsController, 'update'])
        router.post('/workflows/:id/revisions', [WorkflowsController, 'createRevision'])
      })
      .use(middleware.can({ permission: 'workflow.design' }))

    router
      .group(() => {
        router.post('/workflows/:id/publish', [WorkflowsController, 'publish'])
        router.post('/workflows/:id/retire', [WorkflowsController, 'retire'])
      })
      .use(middleware.can({ permission: 'workflow.publish' }))

    router
      .group(() => {
        router.post('/workflow-instances', [WorkflowsController, 'submit'])
        router.post('/workflow-instances/:id/cancel', [WorkflowsController, 'cancelInstance'])
      })
      .use(middleware.can({ permission: 'workflow.submit' }))
    // A leitura de um processo é decidida por processo (quem submeteu, quem tem tarefas, ou `workflow.read`).
    router.get('/workflow-instances/:id', [WorkflowsController, 'showInstance'])
    router
      .get('/dynamic/:entityCode/workflows', [WorkflowsController, 'submittable'])
      .use(middleware.can({ permission: 'workflow.submit', resource: { entity: 'entityCode' } }))
    router
      .get('/dynamic/:entityCode/records/:id/workflow-instances', [
        WorkflowsController,
        'recordInstances',
      ])
      .use(middleware.can({ permission: 'dynamic.read', resource: { entity: 'entityCode' } }))

    router
      .group(() => {
        router.get('/approval-tasks', [WorkflowsController, 'inbox'])
        router.get('/approval-tasks/:id', [WorkflowsController, 'showTask'])
        router.post('/approval-tasks/:id/claim', [WorkflowsController, 'claim'])
        router.post('/approval-tasks/:id/approve', [WorkflowsController, 'approve'])
        router.post('/approval-tasks/:id/reject', [WorkflowsController, 'reject'])
        router.post('/approval-tasks/:id/return', [WorkflowsController, 'return'])
      })
      .use(middleware.can({ permission: 'approval.decide' }))

    router
      .group(() => {
        router.get('/approval-delegations', [WorkflowsController, 'listDelegations'])
        router.post('/approval-delegations', [WorkflowsController, 'createDelegation'])
        router.post('/approval-delegations/:id/revoke', [WorkflowsController, 'revokeDelegation'])
      })
      .use(middleware.can({ permission: 'approval.delegate' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Automações (C15): `automation.read` para ver o catálogo, as automações, simular e consultar o histórico; `automation.manage`
 * para definir, activar, pausar e reprocessar execuções falhadas. Uma automação executa em nome de quem a activa.
 */
router
  .group(() => {
    router
      .group(() => {
        router.get('/automations/catalog', [AutomationsController, 'catalog'])
        router.get('/automations', [AutomationsController, 'list'])
        router.get('/automations/:id', [AutomationsController, 'show'])
        router.post('/automations/:id/simulate', [AutomationsController, 'simulate'])
        router.get('/automation-runs', [AutomationsController, 'listRuns'])
        router.get('/automation-runs/:id', [AutomationsController, 'showRun'])
      })
      .use(middleware.can({ permission: 'automation.read' }))

    router
      .group(() => {
        router.post('/automations', [AutomationsController, 'create'])
        router.patch('/automations/:id', [AutomationsController, 'update'])
        router.post('/automations/:id/activate', [AutomationsController, 'activate'])
        router.post('/automations/:id/pause', [AutomationsController, 'pause'])
        router.post('/automation-runs/:id/retry', [AutomationsController, 'retryRun'])
      })
      .use(middleware.can({ permission: 'automation.manage' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Catálogo (M03): módulo `catalog` do registo. As rotas exigem a funcionalidade efectiva (`catalog.products`, `catalog.prices`:
 * licença AND módulo activo AND funcionalidade ligada) e a permissão própria: `catalog.read|manage` para categorias, produtos
 * e variantes; `price.read|manage` para tabelas de preços e para resolver preços.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/product-categories', [CatalogController, 'listCategories'])
            router.get('/products', [CatalogController, 'listProducts'])
            router.get('/products/:id', [CatalogController, 'showProduct'])
            router.get('/products/:id/variants', [CatalogController, 'listVariants'])
            router.get('/variants/:id', [CatalogController, 'showVariant'])
          })
          .use(middleware.can({ permission: 'catalog.read' }))
        router
          .group(() => {
            router.post('/product-categories', [CatalogController, 'createCategory'])
            router.patch('/product-categories/:id', [CatalogController, 'updateCategory'])
            router.post('/products', [CatalogController, 'createProduct'])
            router.patch('/products/:id', [CatalogController, 'updateProduct'])
            router.post('/products/:id/variants', [CatalogController, 'createVariant'])
            router.patch('/variants/:id', [CatalogController, 'updateVariant'])
          })
          .use(middleware.can({ permission: 'catalog.manage' }))
      })
      .use(middleware.feature({ code: 'catalog.products' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/price-lists', [CatalogController, 'listPriceLists'])
            router.get('/price-lists/:id', [CatalogController, 'showPriceList'])
            router.get('/prices/resolve', [CatalogController, 'resolvePrice'])
          })
          .use(middleware.can({ permission: 'price.read' }))
        router
          .group(() => {
            router.post('/price-lists', [CatalogController, 'createPriceList'])
            router.patch('/price-lists/:id', [CatalogController, 'updatePriceList'])
            router.post('/price-lists/:id/items', [CatalogController, 'addPriceItem'])
            router.patch('/price-list-items/:id', [CatalogController, 'updatePriceItem'])
            router.delete('/price-list-items/:id', [CatalogController, 'deletePriceItem'])
          })
          .use(middleware.can({ permission: 'price.manage' }))
      })
      .use(middleware.feature({ code: 'catalog.prices' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Clientes (M01): módulo `customers` do registo. Funcionalidades `customers.accounts` (clientes e segmentos) e
 * `customers.interactions`; permissões `customer.read|create|update|block|credit.manage` (o limite de crédito só se vê e
 * altera com `customer.credit_manage`).
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/customers', [CustomersController, 'listCustomers'])
            router.get('/customers/:id', [CustomersController, 'showCustomer'])
            router.get('/customer-segments', [CustomersController, 'listSegments'])
          })
          .use(middleware.can({ permission: 'customer.read' }))
        router
          .post('/customers', [CustomersController, 'createCustomer'])
          .use(middleware.can({ permission: 'customer.create' }))
        router
          .group(() => {
            router.patch('/customers/:id', [CustomersController, 'updateCustomer'])
            router.post('/customer-segments', [CustomersController, 'createSegment'])
            router.patch('/customer-segments/:id', [CustomersController, 'updateSegment'])
          })
          .use(middleware.can({ permission: 'customer.update' }))
        router
          .group(() => {
            router.post('/customers/:id/block', [CustomersController, 'blockCustomer'])
            router.post('/customers/:id/unblock', [CustomersController, 'unblockCustomer'])
          })
          .use(middleware.can({ permission: 'customer.block' }))
      })
      .use(middleware.feature({ code: 'customers.accounts' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/interactions', [CustomersController, 'listInteractions'])
            router.get('/interactions/:id', [CustomersController, 'showInteraction'])
          })
          .use(middleware.can({ permission: 'customer.read' }))
        router
          .group(() => {
            router.post('/interactions', [CustomersController, 'createInteraction'])
            router.patch('/interactions/:id', [CustomersController, 'updateInteraction'])
          })
          .use(middleware.can({ permission: 'customer.update' }))
      })
      .use(middleware.feature({ code: 'customers.interactions' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Propostas e encomendas (M04): módulo `orders` do registo. Funcionalidades `orders.quotes` e `orders.orders`;
 * permissões `quote.read|manage`, `order.read|manage` e `sales.confirm` (confirmar e cancelar). Confirmar não reserva stock
 * nem expede nem factura.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/quotes', [OrdersController, 'listQuotes'])
            router.get('/quotes/:id', [OrdersController, 'showQuote'])
          })
          .use(middleware.can({ permission: 'quote.read' }))
        router
          .group(() => {
            router.post('/quotes', [OrdersController, 'createQuote'])
            router.patch('/quotes/:id', [OrdersController, 'updateQuote'])
            router.post('/quotes/:id/lines', [OrdersController, 'addQuoteLine'])
            router.patch('/quotes/:id/lines/:lineId', [OrdersController, 'updateQuoteLine'])
            router.delete('/quotes/:id/lines/:lineId', [OrdersController, 'removeQuoteLine'])
            router.post('/quotes/:id/send', [OrdersController, 'sendQuote'])
            router.post('/quotes/:id/reject', [OrdersController, 'rejectQuote'])
            router.post('/quotes/:id/accept', [OrdersController, 'acceptQuote'])
          })
          .use(middleware.can({ permission: 'quote.manage' }))
      })
      .use(middleware.feature({ code: 'orders.quotes' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/sales-orders', [OrdersController, 'listOrders'])
            router.get('/sales-orders/:id', [OrdersController, 'showOrder'])
          })
          .use(middleware.can({ permission: 'order.read' }))
        router
          .group(() => {
            router.post('/sales-orders', [OrdersController, 'createOrder'])
            router.patch('/sales-orders/:id', [OrdersController, 'updateOrder'])
            router.post('/sales-orders/:id/lines', [OrdersController, 'addOrderLine'])
            router.patch('/sales-orders/:id/lines/:lineId', [OrdersController, 'updateOrderLine'])
            router.delete('/sales-orders/:id/lines/:lineId', [OrdersController, 'removeOrderLine'])
          })
          .use(middleware.can({ permission: 'order.manage' }))
        router
          .group(() => {
            router.post('/sales-orders/:id/confirm', [OrdersController, 'confirmOrder'])
            router.post('/sales-orders/:id/cancel', [OrdersController, 'cancelOrder'])
          })
          .use(middleware.can({ permission: 'sales.confirm' }))
      })
      .use(middleware.feature({ code: 'orders.orders' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/shipments', [OrdersController, 'listShipments'])
            router.get('/shipments/:id', [OrdersController, 'showShipment'])
          })
          .use(middleware.can({ permission: 'shipment.read' }))
        router
          .group(() => {
            router.post('/shipments', [OrdersController, 'createShipment'])
            router.patch('/shipments/:id', [OrdersController, 'updateShipment'])
            router.delete('/shipments/:id', [OrdersController, 'removeShipment'])
            router.post('/shipments/:id/lines', [OrdersController, 'addShipmentLine'])
            router.patch('/shipments/:id/lines/:lineId', [OrdersController, 'updateShipmentLine'])
            router.delete('/shipments/:id/lines/:lineId', [OrdersController, 'removeShipmentLine'])
          })
          .use(middleware.can({ permission: 'shipment.manage' }))
        router
          .group(() => {
            router.post('/shipments/:id/post', [OrdersController, 'postShipment'])
            router.post('/shipments/:id/reverse', [OrdersController, 'reverseShipment'])
          })
          .use(middleware.can({ permission: 'shipment.post' }))
      })
      .use(middleware.feature({ code: 'orders.shipments' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/contracts', [InvoicingController, 'listContracts'])
            router.get('/contracts/:id', [InvoicingController, 'showContract'])
          })
          .use(middleware.can({ permission: 'contract.read' }))
        router
          .group(() => {
            router.post('/contracts', [InvoicingController, 'createContract'])
            router.patch('/contracts/:id', [InvoicingController, 'updateContract'])
            router.post('/contracts/:id/activate', [InvoicingController, 'activateContract'])
            router.post('/contracts/:id/terminate', [InvoicingController, 'terminateContract'])
          })
          .use(middleware.can({ permission: 'contract.manage' }))
      })
      .use(middleware.feature({ code: 'invoicing.contracts' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/invoices', [InvoicingController, 'listInvoices'])
            router.get('/invoices/:id', [InvoicingController, 'showInvoice'])
            router.get('/credit-notes', [InvoicingController, 'listCreditNotes'])
            router.get('/credit-notes/:id', [InvoicingController, 'showCreditNote'])
            router.get('/sales-orders/:orderId/billable', [InvoicingController, 'billable'])
          })
          .use(middleware.can({ permission: 'invoice.read' }))
        router
          .group(() => {
            router.post('/invoices', [InvoicingController, 'createInvoice'])
            router.patch('/invoices/:id', [InvoicingController, 'updateInvoice'])
            router.delete('/invoices/:id', [InvoicingController, 'removeInvoice'])
            router.post('/invoices/:id/lines', [InvoicingController, 'addInvoiceLine'])
            router.delete('/invoices/:id/lines/:lineId', [InvoicingController, 'removeInvoiceLine'])
          })
          .use(middleware.can({ permission: 'invoice.manage' }))
        router
          .post('/invoices/:id/issue', [InvoicingController, 'issueInvoice'])
          .use(middleware.can({ permission: 'invoice.issue' }))
        router
          .group(() => {
            router.post('/credit-notes', [InvoicingController, 'createCreditNote'])
            router.patch('/credit-notes/:id', [InvoicingController, 'updateCreditNote'])
            router.delete('/credit-notes/:id', [InvoicingController, 'removeCreditNote'])
            router.post('/credit-notes/:id/lines', [InvoicingController, 'addCreditNoteLine'])
            router.delete('/credit-notes/:id/lines/:lineId', [
              InvoicingController,
              'removeCreditNoteLine',
            ])
          })
          .use(middleware.can({ permission: 'credit_note.manage' }))
        router
          .post('/credit-notes/:id/issue', [InvoicingController, 'issueCreditNote'])
          .use(middleware.can({ permission: 'credit_note.issue' }))
      })
      .use(middleware.feature({ code: 'invoicing.invoices' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/suppliers', [ProcurementController, 'listSuppliers'])
            router.get('/suppliers/:id', [ProcurementController, 'showSupplier'])
          })
          .use(middleware.can({ permission: 'supplier.read' }))
        router
          .group(() => {
            router.post('/suppliers', [ProcurementController, 'createSupplier'])
            router.patch('/suppliers/:id', [ProcurementController, 'updateSupplier'])
          })
          .use(middleware.can({ permission: 'supplier.manage' }))
      })
      .use(middleware.feature({ code: 'procurement.suppliers' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/purchase-requisitions', [ProcurementController, 'listRequisitions'])
            router.get('/purchase-requisitions/:id', [ProcurementController, 'showRequisition'])
          })
          .use(middleware.can({ permission: 'requisition.read' }))
        router
          .group(() => {
            router.post('/purchase-requisitions', [ProcurementController, 'createRequisition'])
            router.patch('/purchase-requisitions/:id', [ProcurementController, 'updateRequisition'])
            router.delete('/purchase-requisitions/:id', [
              ProcurementController,
              'removeRequisition',
            ])
            router.post('/purchase-requisitions/:id/lines', [
              ProcurementController,
              'addRequisitionLine',
            ])
            router.delete('/purchase-requisitions/:id/lines/:lineId', [
              ProcurementController,
              'removeRequisitionLine',
            ])
            router.post('/purchase-requisitions/:id/submit', [
              ProcurementController,
              'submitRequisition',
            ])
          })
          .use(middleware.can({ permission: 'requisition.manage' }))
        router
          .group(() => {
            router.post('/purchase-requisitions/:id/approve', [
              ProcurementController,
              'approveRequisition',
            ])
            router.post('/purchase-requisitions/:id/reject', [
              ProcurementController,
              'rejectRequisition',
            ])
          })
          .use(middleware.can({ permission: 'requisition.approve' }))
        router
          .group(() => {
            router.post('/purchase-requisitions/:id/convert', [
              ProcurementController,
              'convertRequisition',
            ])
          })
          .use(middleware.can({ permission: 'purchase.manage' }))
      })
      .use(middleware.feature({ code: 'procurement.requisitions' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/purchase-orders', [ProcurementController, 'listPurchases'])
            router.get('/purchase-orders/:id', [ProcurementController, 'showPurchase'])
          })
          .use(middleware.can({ permission: 'purchase.read' }))
        router
          .group(() => {
            router.post('/purchase-orders', [ProcurementController, 'createPurchase'])
            router.patch('/purchase-orders/:id', [ProcurementController, 'updatePurchase'])
            router.delete('/purchase-orders/:id', [ProcurementController, 'removePurchase'])
            router.post('/purchase-orders/:id/lines', [ProcurementController, 'addPurchaseLine'])
            router.delete('/purchase-orders/:id/lines/:lineId', [
              ProcurementController,
              'removePurchaseLine',
            ])
          })
          .use(middleware.can({ permission: 'purchase.manage' }))
        router
          .group(() => {
            router.post('/purchase-orders/:id/confirm', [ProcurementController, 'confirmPurchase'])
            router.post('/purchase-orders/:id/cancel', [ProcurementController, 'cancelPurchase'])
          })
          .use(middleware.can({ permission: 'purchase.confirm' }))
      })
      .use(middleware.feature({ code: 'procurement.orders' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/goods-receipts', [ProcurementController, 'listReceipts'])
            router.get('/goods-receipts/:id', [ProcurementController, 'showReceipt'])
          })
          .use(middleware.can({ permission: 'receipt.read' }))
        router
          .group(() => {
            router.post('/goods-receipts', [ProcurementController, 'createReceipt'])
            router.patch('/goods-receipts/:id', [ProcurementController, 'updateReceipt'])
            router.delete('/goods-receipts/:id', [ProcurementController, 'removeReceipt'])
            router.post('/goods-receipts/:id/lines', [ProcurementController, 'addReceiptLine'])
            router.delete('/goods-receipts/:id/lines/:lineId', [
              ProcurementController,
              'removeReceiptLine',
            ])
          })
          .use(middleware.can({ permission: 'receipt.manage' }))
        router
          .group(() => {
            router.post('/goods-receipts/:id/post', [ProcurementController, 'postReceipt'])
            router.post('/goods-receipts/:id/reverse', [ProcurementController, 'reverseReceipt'])
          })
          .use(middleware.can({ permission: 'receipt.post' }))
      })
      .use(middleware.feature({ code: 'procurement.receipts' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Notificações e comunicação (S02): módulo `notifications` do registo. Funcionalidades `notifications.center` (o centro
 * de cada pessoa e as suas preferências; `notification.read`) e `notifications.delivery` (entregas por canal e pedidos
 * manuais; `communication.manage`). Marcar como lida afecta só o próprio destinatário e abrir o recurso revalida o acesso.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/notifications', [NotificationsController, 'list'])
            router.post('/notifications/read-all', [NotificationsController, 'markAllRead'])
            router.post('/notifications/:id/read', [NotificationsController, 'markRead'])
            router.post('/notifications/:id/open', [NotificationsController, 'open'])
            router.get('/notification-types', [NotificationsController, 'types'])
            router.get('/notification-preferences', [NotificationsController, 'preferences'])
            router.put('/notification-preferences', [NotificationsController, 'updatePreferences'])
          })
          .use(middleware.can({ permission: 'notification.read' }))
      })
      .use(middleware.feature({ code: 'notifications.center' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/notification-deliveries', [NotificationsController, 'listDeliveries'])
            router.post('/notification-deliveries/:id/retry', [
              NotificationsController,
              'retryDelivery',
            ])
            router.post('/notification-requests', [NotificationsController, 'createRequest'])
          })
          .use(middleware.can({ permission: 'communication.manage' }))
      })
      .use(middleware.feature({ code: 'notifications.delivery' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Relatórios, painéis, exportações e pesquisa (S04): módulo `reporting` do registo. Funcionalidades `reporting.reports`,
 * `reporting.dashboards`, `reporting.exports` e `reporting.search`; permissões `report.read|design|export` e `search.read`.
 * As consultas são declarativas sobre datasets registados em código (nunca SQL livre); a autorização vem antes de agregar.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/datasets', [ReportingController, 'datasets'])
            router.get('/reports', [ReportingController, 'listReports'])
            router.get('/reports/:id', [ReportingController, 'showReport'])
            router.post('/reports/:id/run', [ReportingController, 'runReport'])
          })
          .use(middleware.can({ permission: 'report.read' }))
        router
          .group(() => {
            router.post('/reports/preview', [ReportingController, 'previewReport'])
            router.post('/reports', [ReportingController, 'createReport'])
            router.patch('/reports/:id', [ReportingController, 'updateReport'])
            router.post('/reports/:id/publish', [ReportingController, 'publishReport'])
            router.post('/reports/:id/duplicate', [ReportingController, 'duplicateReport'])
            router.delete('/reports/:id', [ReportingController, 'removeReport'])
          })
          .use(middleware.can({ permission: 'report.design' }))
      })
      .use(middleware.feature({ code: 'reporting.reports' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/dashboards', [ReportingController, 'listDashboards'])
            router.get('/dashboards/:id', [ReportingController, 'showDashboard'])
            router.get('/dashboards/:id/data', [ReportingController, 'dashboardData'])
          })
          .use(middleware.can({ permission: 'report.read' }))
        router
          .group(() => {
            router.post('/dashboards', [ReportingController, 'createDashboard'])
            router.patch('/dashboards/:id', [ReportingController, 'updateDashboard'])
            router.delete('/dashboards/:id', [ReportingController, 'removeDashboard'])
            router.post('/dashboards/:id/widgets', [ReportingController, 'addWidget'])
            router.patch('/dashboards/:id/widgets/:widgetId', [ReportingController, 'updateWidget'])
            router.delete('/dashboards/:id/widgets/:widgetId', [
              ReportingController,
              'removeWidget',
            ])
          })
          .use(middleware.can({ permission: 'report.design' }))
      })
      .use(middleware.feature({ code: 'reporting.dashboards' }))

    router
      .group(() => {
        router.post('/exports', [ReportingController, 'requestExport'])
        router.get('/exports', [ReportingController, 'listExports'])
        router.get('/exports/:id', [ReportingController, 'showExport'])
        router.get('/exports/:id/download', [ReportingController, 'downloadExport'])
      })
      .use([
        middleware.feature({ code: 'reporting.exports' }),
        middleware.can({ permission: 'report.export' }),
      ])

    router
      .group(() => {
        router
          .group(() => {
            router.get('/search', [ReportingController, 'search'])
            router.get('/search/status', [ReportingController, 'searchStatus'])
          })
          .use(middleware.can({ permission: 'search.read' }))
        router
          .group(() => {
            router.post('/search/reindex', [ReportingController, 'reindex'])
          })
          .use(middleware.can({ permission: 'report.design' }))
      })
      .use(middleware.feature({ code: 'reporting.search' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Calendário, recursos e reservas (S03): módulo `calendar` do registo. Funcionalidades `calendar.events` (calendários,
 * eventos com séries e excepções, participantes), `calendar.resources` (recursos e reservas; a colisão impede-se na
 * base de dados) e `calendar.business_hours` (horário útil e feriados). Permissões `calendar.read|manage` e
 * `resource.read|manage|book`.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/calendars', [CalendarController, 'listCalendars'])
            router.get('/calendars/:id', [CalendarController, 'showCalendar'])
            router.get('/calendar-events', [CalendarController, 'listEvents'])
            router.get('/calendar-events/:id', [CalendarController, 'showEvent'])
            router.post('/calendar-events/:id/respond', [CalendarController, 'respond'])
          })
          .use(middleware.can({ permission: 'calendar.read' }))
        router
          .group(() => {
            router.post('/calendars', [CalendarController, 'createCalendar'])
            router.patch('/calendars/:id', [CalendarController, 'updateCalendar'])
            router.delete('/calendars/:id', [CalendarController, 'removeCalendar'])
            router.post('/calendar-events', [CalendarController, 'createEvent'])
            router.patch('/calendar-events/:id', [CalendarController, 'updateEvent'])
            router.post('/calendar-events/:id/cancel', [CalendarController, 'cancelEvent'])
            router.post('/calendar-events/:id/participants', [CalendarController, 'addParticipant'])
            router.delete('/calendar-events/:id/participants/:participantId', [
              CalendarController,
              'removeParticipant',
            ])
          })
          .use(middleware.can({ permission: 'calendar.manage' }))
      })
      .use(middleware.feature({ code: 'calendar.events' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/resources', [CalendarController, 'listResources'])
            router.get('/resources/:id', [CalendarController, 'showResource'])
            router.get('/resources/:id/availability', [CalendarController, 'availability'])
            router.get('/resource-bookings', [CalendarController, 'listBookings'])
          })
          .use(middleware.can({ permission: 'resource.read' }))
        router
          .group(() => {
            router.post('/resources', [CalendarController, 'createResource'])
            router.patch('/resources/:id', [CalendarController, 'updateResource'])
            router.delete('/resources/:id', [CalendarController, 'removeResource'])
          })
          .use(middleware.can({ permission: 'resource.manage' }))
        router
          .group(() => {
            router.post('/resource-bookings', [CalendarController, 'createBooking'])
            router.post('/resource-bookings/:id/confirm', [CalendarController, 'confirmBooking'])
            router.post('/resource-bookings/:id/cancel', [CalendarController, 'cancelBooking'])
          })
          .use(middleware.can({ permission: 'resource.book' }))
      })
      .use(middleware.feature({ code: 'calendar.resources' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/business-calendars', [CalendarController, 'listBusiness'])
            router.get('/business-calendars/:id', [CalendarController, 'showBusiness'])
            router.get('/business-calendars/:id/working-time', [CalendarController, 'workingTime'])
          })
          .use(middleware.can({ permission: 'calendar.read' }))
        router
          .group(() => {
            router.post('/business-calendars', [CalendarController, 'createBusiness'])
            router.patch('/business-calendars/:id', [CalendarController, 'updateBusiness'])
            router.delete('/business-calendars/:id', [CalendarController, 'removeBusiness'])
          })
          .use(middleware.can({ permission: 'calendar.manage' }))
      })
      .use(middleware.feature({ code: 'calendar.business_hours' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Documentos, anexos e modelos (S01): módulo `documents` do registo. Funcionalidades `documents.library` (documentos,
 * versões, anexos e anexos de recursos; `document.read|manage`) e `documents.templates` (modelos, rascunhos,
 * pré-visualização, publicação e geração de PDF; `template.read|manage|publish`). O ficheiro só se descarrega quando
 * `AVAILABLE`; a URL assinada é curta e o acesso decide-se de novo ao descarregar.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/documents', [DocumentsController, 'list'])
            router.get('/documents/:id', [DocumentsController, 'show'])
            router.get('/attachments/:id', [DocumentsController, 'showAttachment'])
            router.post('/attachments/:id/download-url', [DocumentsController, 'downloadUrl'])
            router.get('/attachments/:id/download', [DocumentsController, 'download'])
            router.get('/resource-attachments', [DocumentsController, 'listResourceAttachments'])
          })
          .use(middleware.can({ permission: 'document.read' }))
        router
          .group(() => {
            router.post('/documents', [DocumentsController, 'create'])
            router.patch('/documents/:id', [DocumentsController, 'update'])
            router.delete('/documents/:id', [DocumentsController, 'remove'])
            router.post('/documents/:id/versions', [DocumentsController, 'addVersion'])
            router.post('/attachments/prepare', [DocumentsController, 'prepare'])
            router.put('/attachments/:id/content', [DocumentsController, 'content'])
            router.post('/attachments/:id/complete', [DocumentsController, 'complete'])
            router.post('/resource-attachments', [DocumentsController, 'linkResource'])
            router.delete('/resource-attachments/:id', [DocumentsController, 'unlinkResource'])
          })
          .use(middleware.can({ permission: 'document.manage' }))
      })
      .use(middleware.feature({ code: 'documents.library' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/templates', [DocumentsController, 'listTemplates'])
            router.get('/templates/:id', [DocumentsController, 'showTemplate'])
          })
          .use(middleware.can({ permission: 'template.read' }))
        router
          .group(() => {
            router.post('/templates', [DocumentsController, 'createTemplate'])
            router.post('/templates/:id/versions', [DocumentsController, 'addTemplateVersion'])
            router.put('/templates/:id/versions/:versionId', [
              DocumentsController,
              'updateTemplateVersion',
            ])
            router.delete('/templates/:id/versions/:versionId', [
              DocumentsController,
              'deleteTemplateVersion',
            ])
            router.post('/templates/:id/versions/:versionId/preview', [
              DocumentsController,
              'previewTemplateVersion',
            ])
            router.post('/templates/:id/generate', [DocumentsController, 'generate'])
          })
          .use(middleware.can({ permission: 'template.manage' }))
        router
          .group(() => {
            router.post('/templates/:id/versions/:versionId/publish', [
              DocumentsController,
              'publishTemplateVersion',
            ])
          })
          .use(middleware.can({ permission: 'template.publish' }))
      })
      .use(middleware.feature({ code: 'documents.templates' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/** Descarga por URL assinada: só sessão (o tenant vem do token e o acesso volta a decidir-se ao descarregar). */
router
  .group(() => {
    router.get('/files/:token', [DocumentsController, 'file'])
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth()])

/**
 * Prospecção e CRM (M02): módulo `prospecting` do registo. Funcionalidades `prospecting.leads`,
 * `prospecting.opportunities` e `prospecting.campaigns`; permissões `crm.read|manage` e `campaign.send`. Converter uma
 * lead cria a Party, o cliente e a oportunidade numa só transacção e é idempotente; mover uma oportunidade regista a
 * transição com a data; uma campanha respeita o consentimento e a lista de exclusão.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/leads', [ProspectingController, 'listLeads'])
            router.get('/leads/:id', [ProspectingController, 'showLead'])
          })
          .use(middleware.can({ permission: 'crm.read' }))
        router
          .group(() => {
            router.post('/leads', [ProspectingController, 'createLead'])
            router.patch('/leads/:id', [ProspectingController, 'updateLead'])
            router.post('/leads/:id/qualify', [ProspectingController, 'qualifyLead'])
            router.post('/leads/:id/disqualify', [ProspectingController, 'disqualifyLead'])
            router.post('/leads/:id/convert', [ProspectingController, 'convertLead'])
          })
          .use(middleware.can({ permission: 'crm.manage' }))
      })
      .use(middleware.feature({ code: 'prospecting.leads' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/pipeline-stages', [ProspectingController, 'listStages'])
            router.get('/opportunities', [ProspectingController, 'listOpportunities'])
            router.get('/opportunities/metrics', [ProspectingController, 'opportunityMetrics'])
            router.get('/opportunities/:id', [ProspectingController, 'showOpportunity'])
            router.get('/opportunities/:id/history', [ProspectingController, 'opportunityHistory'])
            router.get('/opportunities/:id/activities', [ProspectingController, 'listActivities'])
          })
          .use(middleware.can({ permission: 'crm.read' }))
        router
          .group(() => {
            router.post('/pipeline-stages', [ProspectingController, 'createStage'])
            router.patch('/pipeline-stages/:id', [ProspectingController, 'updateStage'])
            router.post('/opportunities', [ProspectingController, 'createOpportunity'])
            router.patch('/opportunities/:id', [ProspectingController, 'updateOpportunity'])
            router.post('/opportunities/:id/move', [ProspectingController, 'moveOpportunity'])
            router.post('/opportunities/:id/activities', [ProspectingController, 'addActivity'])
            router.post('/opportunity-activities/:id/complete', [
              ProspectingController,
              'completeActivity',
            ])
          })
          .use(middleware.can({ permission: 'crm.manage' }))
      })
      .use(middleware.feature({ code: 'prospecting.opportunities' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/campaigns', [ProspectingController, 'listCampaigns'])
            router.get('/campaigns/:id', [ProspectingController, 'showCampaign'])
            router.get('/campaigns/:id/members', [ProspectingController, 'listMembers'])
            router.get('/marketing-exclusions', [ProspectingController, 'listExclusions'])
          })
          .use(middleware.can({ permission: 'crm.read' }))
        router
          .group(() => {
            router.post('/campaigns', [ProspectingController, 'createCampaign'])
            router.patch('/campaigns/:id', [ProspectingController, 'updateCampaign'])
            router.post('/campaigns/:id/status', [ProspectingController, 'setCampaignStatus'])
            router.post('/campaigns/:id/members', [ProspectingController, 'addMembers'])
            router.delete('/campaigns/:id/members/:memberId', [
              ProspectingController,
              'removeMember',
            ])
            router.post('/campaigns/:id/members/:memberId/respond', [
              ProspectingController,
              'respondMember',
            ])
            router.post('/campaigns/:id/members/:memberId/opt-out', [
              ProspectingController,
              'optOutMember',
            ])
            router.post('/marketing-exclusions', [ProspectingController, 'addExclusion'])
            router.delete('/marketing-exclusions/:id', [ProspectingController, 'removeExclusion'])
          })
          .use(middleware.can({ permission: 'crm.manage' }))
        router
          .post('/campaigns/:id/send', [ProspectingController, 'sendCampaign'])
          .use(middleware.can({ permission: 'campaign.send' }))
      })
      .use(middleware.feature({ code: 'prospecting.campaigns' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Tesouraria, contas a receber e a pagar (M09): módulo `finance` do registo. Funcionalidades `finance.treasury`,
 * `finance.obligations`, `finance.payments` e `finance.supplier_invoices`. Os recebíveis nascem de facturas
 * emitidas e os pagáveis de facturas de fornecedor validadas; ninguém os edita. Confirmar um pagamento é a única
 * operação que movimenta dinheiro, e só se desfaz por reversão.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/treasury-accounts', [FinanceController, 'listAccounts'])
            router.get('/treasury-accounts/:id', [FinanceController, 'showAccount'])
            router.get('/treasury-accounts/:id/entries', [FinanceController, 'statement'])
          })
          .use(middleware.can({ permission: 'treasury.read' }))
        router
          .group(() => {
            router.post('/treasury-accounts', [FinanceController, 'createAccount'])
            router.patch('/treasury-accounts/:id', [FinanceController, 'updateAccount'])
          })
          .use(middleware.can({ permission: 'treasury.manage' }))
      })
      .use(middleware.feature({ code: 'finance.treasury' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/reconciliations/summary', [FinanceController, 'reconSummary'])
            router.get('/reconciliations/batches', [FinanceController, 'listBatches'])
            router.get('/reconciliations/lines', [FinanceController, 'listStatementLines'])
            router.get('/reconciliations/lines/:id', [FinanceController, 'showStatementLine'])
            router.get('/reconciliations/lines/:id/suggestions', [FinanceController, 'suggestions'])
            router.get('/reconciliations/entries', [FinanceController, 'listReconEntries'])
          })
          .use(middleware.can({ permission: 'reconciliation.read' }))
        router
          .group(() => {
            router.post('/reconciliations/imports', [FinanceController, 'importStatement'])
            router.delete('/reconciliations/batches/:id', [FinanceController, 'discardBatch'])
          })
          .use(middleware.can({ permission: 'reconciliation.manage' }))
        router
          .group(() => {
            router.post('/reconciliations/matches', [FinanceController, 'confirmMatch'])
            router.post('/reconciliations/matches/:id/undo', [FinanceController, 'undoMatch'])
          })
          .use(middleware.can({ permission: 'reconciliation.confirm' }))
      })
      .use(middleware.feature({ code: 'finance.reconciliation' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/receivables', [FinanceController, 'listReceivables'])
            router.get('/receivables/:id', [FinanceController, 'showReceivable'])
            router.get('/customers/:id/credit', [FinanceController, 'customerCredit'])
          })
          .use(middleware.can({ permission: 'receivable.read' }))
        router
          .group(() => {
            router.get('/payables', [FinanceController, 'listPayables'])
            router.get('/payables/:id', [FinanceController, 'showPayable'])
          })
          .use(middleware.can({ permission: 'payable.read' }))
      })
      .use(middleware.feature({ code: 'finance.obligations' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/payments', [FinanceController, 'listPayments'])
            router.get('/payments/:id', [FinanceController, 'showPayment'])
          })
          .use(middleware.can({ permission: 'payment.read' }))
        router
          .group(() => {
            router.post('/payments', [FinanceController, 'createPayment'])
            router.post('/payments/:id/submit', [FinanceController, 'submitPayment'])
            router.delete('/payments/:id', [FinanceController, 'removePayment'])
          })
          .use(middleware.can({ permission: 'payment.manage' }))
        router
          .group(() => {
            router.post('/payments/:id/confirm', [FinanceController, 'confirmPayment'])
            router.post('/payments/:id/fail', [FinanceController, 'failPayment'])
            router.post('/payments/:id/reverse', [FinanceController, 'reversePayment'])
          })
          .use(middleware.can({ permission: 'payment.confirm' }))
      })
      .use(middleware.feature({ code: 'finance.payments' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/supplier-invoices', [FinanceController, 'listSupplierInvoices'])
            router.get('/supplier-invoices/:id', [FinanceController, 'showSupplierInvoice'])
          })
          .use(middleware.can({ permission: 'supplier_invoice.read' }))
        router
          .group(() => {
            router.post('/supplier-invoices', [FinanceController, 'createSupplierInvoice'])
            router.patch('/supplier-invoices/:id', [FinanceController, 'updateSupplierInvoice'])
            router.delete('/supplier-invoices/:id', [FinanceController, 'removeSupplierInvoice'])
            router.post('/supplier-invoices/:id/lines', [
              FinanceController,
              'addSupplierInvoiceLine',
            ])
            router.delete('/supplier-invoices/:id/lines/:lineId', [
              FinanceController,
              'removeSupplierInvoiceLine',
            ])
          })
          .use(middleware.can({ permission: 'supplier_invoice.manage' }))
        router
          .group(() => {
            router.post('/supplier-invoices/:id/validate', [
              FinanceController,
              'validateSupplierInvoice',
            ])
            router.post('/supplier-invoices/:id/void', [FinanceController, 'voidSupplierInvoice'])
          })
          .use(middleware.can({ permission: 'supplier_invoice.validate' }))
      })
      .use(middleware.feature({ code: 'finance.supplier_invoices' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Inventário (M07): módulo `inventory` do registo. Funcionalidades `inventory.warehouses` (armazéns e locais) e
 * `inventory.stock` (saldos, movimentos, lotes, ajustes e reservas); permissões `warehouse.manage`, `inventory.read`,
 * `inventory.adjust` e `inventory.reserve`. O saldo nunca se edita: só o livro de movimentos o altera.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/warehouses', [InventoryController, 'listWarehouses'])
            router.get('/warehouses/:id', [InventoryController, 'showWarehouse'])
          })
          .use(middleware.can({ permission: 'inventory.read' }))
        router
          .group(() => {
            router.post('/warehouses', [InventoryController, 'createWarehouse'])
            router.patch('/warehouses/:id', [InventoryController, 'updateWarehouse'])
            router.post('/warehouses/:id/locations', [InventoryController, 'createLocation'])
            router.patch('/stock-locations/:id', [InventoryController, 'updateLocation'])
          })
          .use(middleware.can({ permission: 'warehouse.manage' }))
      })
      .use(middleware.feature({ code: 'inventory.warehouses' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/stock-balances', [InventoryController, 'listBalances'])
            router.get('/stock-movements', [InventoryController, 'listMovements'])
            router.get('/lots', [InventoryController, 'listLots'])
            router.get('/stock-reservations', [InventoryController, 'listReservations'])
          })
          .use(middleware.can({ permission: 'inventory.read' }))
        router
          .group(() => {
            router.post('/stock-adjustments', [InventoryController, 'adjust'])
            router.post('/stock-movements/:id/reverse', [InventoryController, 'reverse'])
            router.post('/lots', [InventoryController, 'createLot'])
          })
          .use(middleware.can({ permission: 'inventory.adjust' }))
        router
          .group(() => {
            router.post('/stock-reservations', [InventoryController, 'createReservation'])
            router.post('/stock-reservations/expire', [InventoryController, 'expireReservations'])
            router.post('/stock-reservations/:id/release', [
              InventoryController,
              'releaseReservation',
            ])
          })
          .use(middleware.can({ permission: 'inventory.reserve' }))
      })
      .use(middleware.feature({ code: 'inventory.stock' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Logística de stock (M08), no módulo `inventory`: funcionalidades `inventory.transfers`, `inventory.counts` e
 * `inventory.returns`. Nenhuma altera saldos directamente: todos os efeitos são movimentos do livro.
 */
router
  .group(() => {
    router
      .group(() => {
        router
          .group(() => {
            router.get('/stock-transfers', [LogisticsController, 'listTransfers'])
            router.get('/stock-transfers/:id', [LogisticsController, 'showTransfer'])
          })
          .use(middleware.can({ permission: 'transfer.read' }))
        router
          .group(() => {
            router.post('/stock-transfers', [LogisticsController, 'createTransfer'])
            router.patch('/stock-transfers/:id', [LogisticsController, 'updateTransfer'])
            router.delete('/stock-transfers/:id', [LogisticsController, 'removeTransfer'])
            router.post('/stock-transfers/:id/lines', [LogisticsController, 'addTransferLine'])
            router.delete('/stock-transfers/:id/lines/:lineId', [
              LogisticsController,
              'removeTransferLine',
            ])
            router.post('/stock-transfers/:id/cancel', [LogisticsController, 'cancelTransfer'])
          })
          .use(middleware.can({ permission: 'transfer.manage' }))
        router
          .post('/stock-transfers/:id/dispatch', [LogisticsController, 'dispatchTransfer'])
          .use(middleware.can({ permission: 'transfer.dispatch' }))
        router
          .post('/stock-transfers/:id/receive', [LogisticsController, 'receiveTransfer'])
          .use(middleware.can({ permission: 'transfer.receive' }))
      })
      .use(middleware.feature({ code: 'inventory.transfers' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/stock-counts', [LogisticsController, 'listCounts'])
            router.get('/stock-counts/:id', [LogisticsController, 'showCount'])
          })
          .use(middleware.can({ permission: 'count.read' }))
        router
          .group(() => {
            router.post('/stock-counts', [LogisticsController, 'createCount'])
            router.delete('/stock-counts/:id', [LogisticsController, 'removeCount'])
            router.post('/stock-counts/:id/open', [LogisticsController, 'openCount'])
            router.put('/stock-counts/:id/counts', [LogisticsController, 'countLines'])
            router.post('/stock-counts/:id/lines', [LogisticsController, 'addCountLine'])
            router.post('/stock-counts/:id/review', [LogisticsController, 'reviewCount'])
            router.post('/stock-counts/:id/reopen', [LogisticsController, 'reopenCount'])
            router.post('/stock-counts/:id/cancel', [LogisticsController, 'cancelCount'])
          })
          .use(middleware.can({ permission: 'count.manage' }))
        router
          .post('/stock-counts/:id/post', [LogisticsController, 'postCount'])
          .use(middleware.can({ permission: 'count.post' }))
      })
      .use(middleware.feature({ code: 'inventory.counts' }))

    router
      .group(() => {
        router
          .group(() => {
            router.get('/goods-returns', [LogisticsController, 'listReturns'])
            router.get('/goods-returns/source-lines', [LogisticsController, 'returnSourceLines'])
            router.get('/goods-returns/:id', [LogisticsController, 'showReturn'])
          })
          .use(middleware.can({ permission: 'return.read' }))
        router
          .group(() => {
            router.post('/goods-returns', [LogisticsController, 'createReturn'])
            router.delete('/goods-returns/:id', [LogisticsController, 'removeReturn'])
            router.post('/goods-returns/:id/lines', [LogisticsController, 'addReturnLine'])
            router.delete('/goods-returns/:id/lines/:lineId', [
              LogisticsController,
              'removeReturnLine',
            ])
          })
          .use(middleware.can({ permission: 'return.manage' }))
        router
          .group(() => {
            router.post('/goods-returns/:id/approve', [LogisticsController, 'approveReturn'])
            router.post('/goods-returns/:id/post', [LogisticsController, 'postReturn'])
          })
          .use(middleware.can({ permission: 'return.post' }))
      })
      .use(middleware.feature({ code: 'inventory.returns' }))
  })
  .prefix('/api/v1')
  .use([middleware.origin(), middleware.auth(), middleware.tenant()])

/**
 * Administração da plataforma (SaaS): rotas **sem** selector de tenant, com política própria (`platform.*`).
 * Uma concessão de plataforma não dá acesso a dados empresariais de nenhum tenant.
 */
router
  .group(() => {
    router.get('/me', [PlatformController, 'me'])

    router
      .group(() => {
        router.get('/tenants', [PlatformController, 'listTenants'])
        router.post('/tenants', [PlatformController, 'provision'])
        router.get('/tenants/:id', [PlatformController, 'showTenant'])
        router.post('/tenants/:id/suspend', [PlatformController, 'suspend'])
        router.post('/tenants/:id/resume', [PlatformController, 'resume'])
      })
      .use(middleware.platform({ permission: 'platform.tenant.manage' }))

    router
      .group(() => {
        router.get('/plans', [PlatformController, 'listPlans'])
        router.post('/plans', [PlatformController, 'createPlan'])
        router.post('/plans/:code/revisions/:revision/publish', [PlatformController, 'publishPlan'])
        router.post('/plans/:code/revisions/:revision/retire', [PlatformController, 'retirePlan'])
        router.get('/tenants/:id/subscription', [PlatformController, 'showSubscription'])
        router.post('/tenants/:id/subscription', [PlatformController, 'assign'])
        router.put('/tenants/:id/subscription/plan', [PlatformController, 'changePlan'])
        router.put('/tenants/:id/subscription/status', [PlatformController, 'setStatus'])
      })
      .use(middleware.platform({ permission: 'platform.billing.manage' }))
  })
  .prefix('/api/v1/platform')
  .use([middleware.origin(), middleware.auth()])
