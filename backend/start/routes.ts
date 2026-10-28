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
