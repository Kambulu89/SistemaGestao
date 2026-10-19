/**
 * Dados de demonstração. Isolados nesta pasta: apagar `core/mock/` e fornecer
 * adapters HTTP é tudo o que é preciso para ligar a um backend real.
 * Os módulos referenciam-se por código e convertem-se em ids com `moduleId`.
 */
import type { User } from '../auth/auth.model';
import { moduleId } from '../modules/define-module';
import type { Plan, Subscription } from '../subscription/subscription.model';
import type { Tenant, TenantContext, TenantModule } from '../tenant-context/tenant.model';

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
  {
    email: 'frota@demo.pt',
    description: 'Administrador dos Transportes Atlas (entidades dinâmicas)',
  },
  {
    email: 'operador@demo.pt',
    description: 'Operador de frota nos Transportes Atlas (permissões limitadas)',
  },
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
  { id: 'u-frota', name: 'Paulo Frota', email: 'frota@demo.pt', platformPermissions: [] },
  { id: 'u-operador', name: 'Sofia Operadora', email: 'operador@demo.pt', platformPermissions: [] },
];

const regional = { locale: 'pt-PT', currency: 'EUR', timeZone: 'Europe/Lisbon' };

export const MOCK_TENANTS: readonly Tenant[] = [
  {
    id: 't-escola',
    slug: 'escola-horizonte',
    name: 'Escola Horizonte',
    status: 'active',
    ...regional,
  },
  { id: 't-clinica', slug: 'clinica-vida', name: 'Clínica Vida', status: 'trial', ...regional },
  {
    id: 't-atlas',
    slug: 'transportes-atlas',
    name: 'Transportes Atlas',
    status: 'active',
    ...regional,
    locale: 'pt-AO',
    currency: 'AOA',
    timeZone: 'Africa/Luanda',
  },
];

// ---------------------------------------------------------------- planos

const ids = (codes: readonly string[]): readonly string[] => codes.map(moduleId);

const STARTER_CODES = [
  'crm.customers',
  'crm.pipeline',
  'sales.catalog',
  'sales.orders',
  'documents.dms',
  'calendar.scheduling',
  'reporting.dashboards',
  'projects.tasks',
] as const;

const BUSINESS_CODES = [
  ...STARTER_CODES,
  'crm.campaigns',
  'sales.billing',
  'procurement.suppliers',
  'procurement.orders',
  'inventory.warehouses',
  'inventory.movements',
  'finance.cash-banks',
  'finance.receivables-payables',
  'hr.employees',
  'hr.attendance',
  'workflow.flows',
  'reporting.reports',
  'configuration.forms',
  'iam.teams',
  'organization.cost-centers',
  'support.tickets',
  'documents.versioning',
] as const;

const ENTERPRISE_CODES = [
  ...BUSINESS_CODES,
  'inventory.stocktaking',
  'finance.payments-budget',
  'hr.talent',
  'projects.timesheets',
  'support.knowledge-base',
  'workflow.rules',
  'integrations.api-webhooks',
  'integrations.erp-import',
  'governance.compliance',
  'configuration.localization',
] as const;

export const MOCK_PLANS: readonly Plan[] = [
  {
    id: 'plan-starter',
    code: 'starter',
    name: 'Starter',
    description: 'Para equipas pequenas que começam a organizar-se.',
    moduleIds: ids(STARTER_CODES),
    limits: [
      { key: 'users', label: 'Utilizadores', limit: 10 },
      { key: 'storage', label: 'Armazenamento', limit: 5, unit: 'GB' },
    ],
  },
  {
    id: 'plan-business',
    code: 'business',
    name: 'Business',
    description: 'Operação completa para PME.',
    moduleIds: ids(BUSINESS_CODES),
    limits: [
      { key: 'users', label: 'Utilizadores', limit: 100 },
      { key: 'storage', label: 'Armazenamento', limit: 50, unit: 'GB' },
    ],
  },
  {
    id: 'plan-enterprise',
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Todos os módulos, sem limites de utilizadores.',
    moduleIds: ids(ENTERPRISE_CODES),
    limits: [
      { key: 'users', label: 'Utilizadores', limit: null },
      { key: 'storage', label: 'Armazenamento', limit: 500, unit: 'GB' },
    ],
  },
];

// ------------------------------------------------------- subscrições

const planLimits = (code: string, usage: Record<string, number>) => {
  const plan = MOCK_PLANS.find((p) => p.code === code);
  return (plan?.limits ?? []).map((l) => ({ ...l, used: usage[l.key] ?? 0 }));
};

const planModuleIds = (code: string): readonly string[] =>
  MOCK_PLANS.find((p) => p.code === code)?.moduleIds ?? [];

export const MOCK_SUBSCRIPTIONS: readonly Subscription[] = [
  {
    id: 'sub-escola',
    tenantId: 't-escola',
    planCode: 'business',
    status: 'active',
    startedAt: '2025-09-01',
    renewsAt: '2026-09-01',
    // Plano Business + módulo adicional (add-on) de Avaliação, formação e recrutamento.
    moduleIds: [...planModuleIds('business'), moduleId('hr.talent')],
    limits: planLimits('business', { users: 62, storage: 18 }),
  },
  {
    id: 'sub-clinica',
    tenantId: 't-clinica',
    planCode: 'starter',
    status: 'trial',
    startedAt: '2026-09-20',
    renewsAt: '2026-10-20',
    // Starter + add-on de Contratos e faturação (sem ter ainda activado Orçamentos e vendas).
    moduleIds: [...planModuleIds('starter'), moduleId('sales.billing')],
    limits: planLimits('starter', { users: 9, storage: 4 }),
  },
  {
    id: 'sub-atlas',
    tenantId: 't-atlas',
    planCode: 'business',
    status: 'active',
    startedAt: '2025-03-01',
    renewsAt: '2027-03-01',
    moduleIds: planModuleIds('business'),
    limits: planLimits('business', { users: 48, storage: 31 }),
  },
];

// ------------------------------------------------- módulos por tenant

const on = (code: string, over: Partial<TenantModule> = {}): TenantModule => ({
  moduleId: moduleId(code),
  active: true,
  features: [],
  settings: {},
  ...over,
});
const off = (code: string): TenantModule => on(code, { active: false });

interface TenantSetup {
  readonly modules: readonly TenantModule[];
  readonly featureFlags: Readonly<Record<string, boolean>>;
}

export const MOCK_TENANT_SETUP: Readonly<Record<string, TenantSetup>> = {
  't-escola': {
    modules: [
      on('crm.customers', { features: ['import'], settings: { requireTaxId: true } }),
      on('crm.pipeline'),
      on('sales.catalog'),
      on('sales.orders', { settings: { quoteValidityDays: 15 } }),
      on('documents.dms'),
      on('calendar.scheduling'),
      on('reporting.dashboards'),
      on('projects.tasks'),
      on('hr.employees'),
      on('hr.attendance'),
      on('hr.talent'),
      on('finance.cash-banks'),
      on('iam.teams'),
      on('workflow.flows'),
      on('configuration.forms'),
      // Contratados mas ainda não activados pelo tenant:
      off('finance.receivables-payables'),
      off('procurement.suppliers'),
      off('inventory.warehouses'),
    ],
    featureFlags: {
      'crm.import': true,
      'configuration.form-builder': true,
      'workflow.automations': false,
    },
  },
  't-clinica': {
    modules: [
      on('crm.customers'),
      on('crm.pipeline'),
      on('documents.dms'),
      on('calendar.scheduling'),
      on('reporting.dashboards'),
      // Activo, mas "Orçamentos e vendas" (de que depende) não está activado → dependência em falta.
      on('sales.billing'),
      off('sales.orders'),
      off('projects.tasks'),
    ],
    featureFlags: { 'crm.import': false },
  },
  't-atlas': {
    modules: [on('crm.customers'), on('configuration.forms')],
    featureFlags: { 'configuration.form-builder': true },
  },
};

// ------------------------------------------------ papéis e permissões

interface MockMembership {
  readonly userId: string;
  readonly tenantId: string;
  readonly roleName: string;
  readonly permissions: readonly string[];
}

export const MOCK_MEMBERSHIPS: readonly MockMembership[] = [
  { userId: 'u-escola', tenantId: 't-escola', roleName: 'Administrador', permissions: ['*'] },
  {
    userId: 'u-root',
    tenantId: 't-escola',
    roleName: 'Suporte da plataforma',
    permissions: ['organization.units.read', 'iam.users.read', 'crm.customers.read'],
  },
  {
    userId: 'u-multi',
    tenantId: 't-escola',
    roleName: 'Secretário',
    permissions: [
      'organization.units.read',
      'crm.customers.read',
      'entities.customer.read',
      'entities.customer.create',
      'entities.customer.update',
      'crm.pipeline.read',
      'calendar.scheduling.read',
      'documents.dms.read',
      'hr.employees.read',
      'tenant.settings.read',
    ],
  },
  { userId: 'u-multi', tenantId: 't-clinica', roleName: 'Administrador', permissions: ['*'] },
  { userId: 'u-frota', tenantId: 't-atlas', roleName: 'Administrador', permissions: ['*'] },
  {
    userId: 'u-operador',
    tenantId: 't-atlas',
    roleName: 'Operador de frota',
    // Pode consultar, criar e editar viaturas e fazer transições simples; não elimina nem aprova.
    permissions: [
      'entities.vehicle.read',
      'entities.vehicle.create',
      'entities.vehicle.update',
      'entities.vehicle.transition',
      'entities.driver.read',
      'entities.note.read',
      'entities.note.create',
      'entities.customer.read',
      'entities.customer.create',
      'entities.customer.update',
      'crm.customers.read',
    ],
  },
];

export function buildTenantContext(
  userId: string | undefined,
  tenantId: string,
): TenantContext | null {
  const membership = MOCK_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId);
  const tenant = MOCK_TENANTS.find((t) => t.id === tenantId);
  const subscription = MOCK_SUBSCRIPTIONS.find((s) => s.tenantId === tenantId);
  const setup = MOCK_TENANT_SETUP[tenantId];
  if (!membership || !tenant || !subscription || !setup) return null;
  return {
    tenant,
    roleName: membership.roleName,
    permissions: membership.permissions,
    subscription,
    ...setup,
  };
}
