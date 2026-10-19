import type { Subscription } from '../subscription/subscription.model';
import type { TenantModule } from '../tenant-context/tenant.model';
import { defineModule, moduleId } from './define-module';
import {
  type ModuleAccessContext,
  resolveFeatureAccess,
  resolveModuleAccess,
} from './module-access';
import type { ModuleManifest } from './module.model';

const crm = defineModule({
  code: 'crm.customers',
  name: 'Clientes',
  description: '',
  group: 'crm',
  icon: 'users',
});
const edu = defineModule({
  code: 'education.students',
  name: 'Alunos',
  description: '',
  group: 'education',
  icon: 'academic',
  dependencies: ['crm.customers'],
  featureFlag: 'edu.enabled',
});
const auth = defineModule({
  code: 'iam.authentication',
  name: 'Autenticação',
  description: '',
  group: 'iam',
  icon: 'lock',
  kind: 'foundation',
});

const catalog = [crm, edu, auth];

const tenantModule = (code: string, active = true, features: string[] = []): TenantModule => ({
  moduleId: moduleId(code),
  active,
  features,
  settings: {},
});

const subscription = (
  codes: string[],
  status: Subscription['status'] = 'active',
): Subscription => ({
  id: 's',
  tenantId: 't',
  planCode: 'p',
  status,
  startedAt: '2026-01-01',
  renewsAt: null,
  moduleIds: codes.map(moduleId),
  limits: [],
});

function context(over: Partial<ModuleAccessContext> = {}): ModuleAccessContext {
  return {
    subscription: subscription(['crm.customers', 'education.students']),
    tenantModules: [tenantModule('crm.customers'), tenantModule('education.students')],
    manifestOf: (id) => catalog.find((m) => m.id === id),
    isFlagEnabled: () => true,
    can: () => true,
    ...over,
  };
}

const resolve = (manifest: ModuleManifest, over?: Partial<ModuleAccessContext>) =>
  resolveModuleAccess(manifest, context(over));

describe('resolveModuleAccess', () => {
  it('is accessible when contracted, active, dependencies ready, flag on and permitted', () => {
    expect(resolve(edu)).toBe('accessible');
  });

  it('distinguishes "not contracted" (not in the subscription) from "inactive" (contracted, not activated)', () => {
    expect(resolve(edu, { subscription: subscription(['crm.customers']) })).toBe('not-contracted');
    expect(resolve(edu, { tenantModules: [tenantModule('crm.customers')] })).toBe('inactive');
    expect(
      resolve(edu, {
        tenantModules: [tenantModule('crm.customers'), tenantModule('education.students', false)],
      }),
    ).toBe('inactive');
  });

  it('requires dependencies to be contracted AND active', () => {
    expect(
      resolve(edu, {
        tenantModules: [tenantModule('crm.customers', false), tenantModule('education.students')],
      }),
    ).toBe('missing-dependency');
    expect(resolve(edu, { subscription: subscription(['education.students']) })).toBe(
      'missing-dependency',
    );
  });

  it('respects the module feature flag', () => {
    expect(resolve(edu, { isFlagEnabled: () => false })).toBe('flag-disabled');
  });

  it('keeps "activated" and "authorized" separate', () => {
    expect(resolve(edu, { can: () => false })).toBe('forbidden');
  });

  it('blocks contractable modules when the subscription is suspended or cancelled', () => {
    expect(resolve(crm, { subscription: subscription(['crm.customers'], 'suspended') })).toBe(
      'subscription-inactive',
    );
    expect(resolve(crm, { subscription: subscription(['crm.customers'], 'cancelled') })).toBe(
      'subscription-inactive',
    );
    expect(resolve(crm, { subscription: null })).toBe('subscription-inactive');
  });

  it('keeps working in trial and past_due', () => {
    expect(resolve(crm, { subscription: subscription(['crm.customers'], 'trial') })).toBe(
      'accessible',
    );
    expect(resolve(crm, { subscription: subscription(['crm.customers'], 'past_due') })).toBe(
      'accessible',
    );
  });

  it('never exposes a retired module', () => {
    const retired = defineModule({
      code: 'old.thing',
      name: 'Old',
      description: '',
      group: 'crm',
      icon: 'cube',
      lifecycle: 'retired',
    });
    expect(resolve(retired)).toBe('retired');
  });

  it('treats foundation capabilities as always included: only permissions apply', () => {
    expect(resolve(auth, { subscription: null, tenantModules: [] })).toBe('accessible');
    expect(resolve(auth, { can: () => false })).toBe('forbidden');
  });

  it('checks contract before permission (what the tenant lacks is not "forbidden")', () => {
    expect(resolve(edu, { subscription: subscription([]), can: () => false })).toBe(
      'not-contracted',
    );
  });
});

describe('resolveFeatureAccess', () => {
  const feature = {
    id: 'import',
    name: 'Import',
    description: '',
    flag: 'crm.import',
    permission: 'crm.customers.manage',
  };
  const ctx = { isFlagEnabled: () => true, can: () => true };
  const enabled = tenantModule('crm.customers', true, ['import']);

  it('needs an accessible module, tenant enablement, flag and permission', () => {
    expect(resolveFeatureAccess(feature, 'accessible', enabled, ctx)).toBe('available');
    expect(resolveFeatureAccess(feature, 'inactive', enabled, ctx)).toBe('module-unavailable');
    expect(resolveFeatureAccess(feature, 'accessible', tenantModule('crm.customers'), ctx)).toBe(
      'not-enabled',
    );
    expect(
      resolveFeatureAccess(feature, 'accessible', enabled, { ...ctx, isFlagEnabled: () => false }),
    ).toBe('flag-disabled');
    expect(resolveFeatureAccess(feature, 'accessible', enabled, { ...ctx, can: () => false })).toBe(
      'forbidden',
    );
  });
});
