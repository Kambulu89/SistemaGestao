import { defineModule } from '../define-module';

/**
 * Capacidades estruturais do catálogo. Fazem parte da fundação da plataforma (não se contratam
 * nem se desactivam) e têm a sua UI nas áreas de administração, não como módulos de negócio.
 */
const platform = { kind: 'foundation', scope: 'platform' } as const;
const tenant = { kind: 'foundation', scope: 'tenant' } as const;

export const FOUNDATION_CAPABILITIES = [
  defineModule({
    ...platform,
    code: 'core.multi-tenancy',
    name: 'Multi-Tenancy',
    description: 'Isolamento e contexto por organização.',
    group: 'core',
    icon: 'building',
    permissions: [{ key: 'platform.access', name: 'Aceder à administração da plataforma' }],
  }),
  defineModule({
    ...platform,
    code: 'core.tenant-management',
    name: 'Tenant Management',
    description: 'Criação, estado e ciclo de vida dos tenants.',
    group: 'core',
    icon: 'building',
    permissions: [
      { key: 'platform.tenants.read', name: 'Ver tenants' },
      { key: 'platform.tenants.manage', name: 'Gerir tenants' },
    ],
  }),
  defineModule({
    ...platform,
    code: 'core.subscription',
    name: 'Subscription',
    description: 'Planos, subscrições, direitos e limites de utilização.',
    group: 'core',
    icon: 'card',
    permissions: [
      { key: 'platform.plans.read', name: 'Ver planos' },
      { key: 'platform.subscriptions.read', name: 'Ver subscrições' },
      { key: 'platform.subscriptions.manage', name: 'Gerir subscrições' },
    ],
  }),
  defineModule({
    ...platform,
    code: 'core.feature-flags',
    name: 'Feature Flags',
    description: 'Activação controlada de funcionalidades.',
    group: 'core',
    icon: 'bolt',
    permissions: [
      { key: 'platform.flags.read', name: 'Ver feature flags' },
      { key: 'platform.flags.manage', name: 'Gerir feature flags' },
    ],
  }),
  defineModule({
    ...platform,
    code: 'core.module-registry',
    name: 'Module Registry',
    description: 'Catálogo central de módulos, versões e dependências.',
    group: 'core',
    icon: 'cube',
    permissions: [{ key: 'platform.modules.read', name: 'Ver catálogo de módulos' }],
  }),
  defineModule({
    ...tenant,
    code: 'iam.authentication',
    name: 'Autenticação',
    description: 'Sessões, credenciais e recuperação de acesso.',
    group: 'iam',
    icon: 'lock',
    permissions: [{ key: 'iam.authentication.manage', name: 'Gerir autenticação' }],
  }),
  defineModule({
    ...tenant,
    code: 'iam.users',
    name: 'Utilizadores',
    description: 'Utilizadores e membros da organização.',
    group: 'iam',
    icon: 'users',
  }),
  defineModule({
    ...tenant,
    code: 'iam.access-control',
    name: 'RBAC/ABAC',
    description: 'Perfis, permissões e políticas de acesso.',
    group: 'iam',
    icon: 'shield',
  }),
  defineModule({
    ...tenant,
    code: 'organization.units',
    name: 'Empresa e unidades',
    description: 'Dados da empresa, departamentos, filiais e unidades organizacionais.',
    group: 'organization',
    icon: 'building',
  }),
  defineModule({
    ...tenant,
    code: 'communication.notifications',
    name: 'Notificações',
    description: 'Avisos e mensagens transversais aos módulos.',
    group: 'communication',
    icon: 'bell',
  }),
  defineModule({
    ...tenant,
    code: 'governance.audit',
    name: 'Auditoria e logs',
    description: 'Registo de operações relevantes.',
    group: 'governance',
    icon: 'document',
  }),
] as const;
