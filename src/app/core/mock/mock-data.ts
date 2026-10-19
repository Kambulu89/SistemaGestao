/**
 * Dados de demonstração. Isolados nesta pasta: apagar `core/mock/` e fornecer
 * adapters HTTP é tudo o que é preciso para ligar a um backend real.
 */
import type { ModuleManifest } from '../modules/module.model';
import type { Tenant, TenantContext, TenantModuleState } from '../tenant-context/tenant.model';
import type { User } from '../auth/auth.model';

export const MOCK_PASSWORD = 'demo1234';

/** Contas de demonstração (mostradas no login fora de produção). */
export const DEMO_ACCOUNTS = [
  {
    email: 'plataforma@demo.pt',
    description: 'Administrador da plataforma (+ suporte na Escola Horizonte)',
  },
  {
    email: 'multi@demo.pt',
    description: 'Dois tenants: Secretário na Escola, Administrador na Clínica',
  },
  { email: 'escola@demo.pt', description: 'Administrador da Escola Horizonte' },
] as const;

export const MOCK_USERS: readonly User[] = [
  {
    id: 'u-root',
    name: 'Ana Plataforma',
    email: 'plataforma@demo.pt',
    platformPermissions: ['platform.*'],
  },
  { id: 'u-multi', name: 'Rui Multi-tenant', email: 'multi@demo.pt', platformPermissions: [] },
  { id: 'u-escola', name: 'Marta Escola', email: 'escola@demo.pt', platformPermissions: [] },
];

const base = { locale: 'pt-PT', currency: 'EUR', timeZone: 'Europe/Lisbon' };

export const MOCK_TENANTS: readonly Tenant[] = [
  {
    id: 't-escola',
    slug: 'escola-horizonte',
    name: 'Escola Horizonte',
    status: 'active',
    planName: 'Business',
    ...base,
  },
  {
    id: 't-clinica',
    slug: 'clinica-vida',
    name: 'Clínica Vida',
    status: 'trial',
    planName: 'Starter',
    ...base,
  },
  {
    id: 't-atlas',
    slug: 'transportes-atlas',
    name: 'Transportes Atlas',
    status: 'suspended',
    planName: 'Business',
    ...base,
    currency: 'AOA',
    timeZone: 'Africa/Luanda',
    locale: 'pt-AO',
  },
];

const ALL_ACCESS = [
  'tenant.*',
  'crm.*',
  'finance.*',
  'hr.*',
  'dynamic.*',
  'education.*',
  'health.*',
];

interface MockMembership {
  readonly userId: string;
  readonly tenantId: string;
  readonly roleName: string;
  readonly permissions: readonly string[];
}

export const MOCK_MEMBERSHIPS: readonly MockMembership[] = [
  { userId: 'u-escola', tenantId: 't-escola', roleName: 'Administrador', permissions: ALL_ACCESS },
  {
    userId: 'u-root',
    tenantId: 't-escola',
    roleName: 'Suporte da plataforma',
    permissions: [
      'tenant.organization.read',
      'tenant.users.read',
      'crm.access',
      'crm.contacts.read',
    ],
  },
  {
    userId: 'u-multi',
    tenantId: 't-escola',
    roleName: 'Secretário',
    permissions: [
      'tenant.organization.read',
      'crm.access',
      'crm.contacts.read',
      'education.access',
      'education.students.read',
      'education.enrollments.read',
    ],
  },
  { userId: 'u-multi', tenantId: 't-clinica', roleName: 'Administrador', permissions: ALL_ACCESS },
];

const state = (moduleId: string, contracted: boolean, active: boolean): TenantModuleState => ({
  moduleId,
  contracted,
  active,
});

export const MOCK_TENANT_SETUP: Readonly<
  Record<string, Pick<TenantContext, 'modules' | 'featureFlags'>>
> = {
  't-escola': {
    modules: [
      state('crm', true, true),
      state('finance', true, true),
      state('hr', true, false),
      state('dynamic-forms', true, true),
      state('education', true, true),
    ],
    featureFlags: { 'dynamic.forms': true },
  },
  't-clinica': {
    modules: [
      state('crm', true, true),
      state('finance', true, false),
      state('dynamic-forms', true, true),
      state('workflows', true, true),
      state('health', true, true),
    ],
    featureFlags: { 'dynamic.forms': false },
  },
  't-atlas': { modules: [state('crm', true, true)], featureFlags: {} },
};

export const MOCK_CATALOG: readonly ModuleManifest[] = [
  {
    id: 'crm',
    name: 'CRM',
    description: 'Contactos, clientes e relacionamento.',
    icon: 'users',
    group: 'general',
    permissions: ['crm.access'],
    dependencies: [],
    routes: [
      { path: 'contacts', label: 'Contactos', permission: 'crm.contacts.read' },
      { path: 'accounts', label: 'Contas', permission: 'crm.accounts.read' },
    ],
  },
  {
    id: 'finance',
    name: 'Financeiro',
    description: 'Facturação, pagamentos e tesouraria.',
    icon: 'card',
    group: 'general',
    permissions: ['finance.access'],
    dependencies: [],
    routes: [
      { path: 'invoices', label: 'Facturas', permission: 'finance.invoices.read' },
      { path: 'payments', label: 'Pagamentos', permission: 'finance.payments.read' },
    ],
  },
  {
    id: 'hr',
    name: 'Recursos Humanos',
    description: 'Colaboradores, férias e assiduidade.',
    icon: 'users',
    group: 'general',
    permissions: ['hr.access'],
    dependencies: [],
    routes: [{ path: 'employees', label: 'Colaboradores', permission: 'hr.employees.read' }],
  },
  {
    id: 'dynamic-forms',
    name: 'Formulários dinâmicos',
    description: 'Campos e formulários personalizados definidos pelo tenant.',
    icon: 'document',
    group: 'dynamic',
    permissions: ['dynamic.access'],
    dependencies: [],
    featureFlag: 'dynamic.forms',
    routes: [{ path: 'forms', label: 'Formulários', permission: 'dynamic.forms.read' }],
  },
  {
    id: 'workflows',
    name: 'Workflows',
    description: 'Fluxos de aprovação e estados configuráveis.',
    icon: 'bolt',
    group: 'dynamic',
    permissions: ['dynamic.access'],
    dependencies: ['dynamic-forms'],
    routes: [{ path: 'definitions', label: 'Definições', permission: 'dynamic.workflows.read' }],
  },
  {
    id: 'education',
    name: 'Educação',
    description: 'Alunos, turmas, matrículas e avaliações.',
    icon: 'academic',
    group: 'vertical',
    permissions: ['education.access'],
    dependencies: ['crm'],
    routes: [
      { path: 'students', label: 'Alunos', permission: 'education.students.read' },
      { path: 'classes', label: 'Turmas', permission: 'education.classes.read' },
      { path: 'enrollments', label: 'Matrículas', permission: 'education.enrollments.read' },
    ],
  },
  {
    id: 'health',
    name: 'Saúde',
    description: 'Pacientes, consultas e agendamentos.',
    icon: 'heart',
    group: 'vertical',
    permissions: ['health.access'],
    dependencies: ['crm'],
    routes: [
      { path: 'patients', label: 'Pacientes', permission: 'health.patients.read' },
      { path: 'appointments', label: 'Consultas', permission: 'health.appointments.read' },
    ],
  },
];
