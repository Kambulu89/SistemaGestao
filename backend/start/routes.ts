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
