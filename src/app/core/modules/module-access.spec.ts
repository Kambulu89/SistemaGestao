import type { TenantModuleState } from '../tenant-context/tenant.model';
import { type ModuleAccessContext, resolveModuleAccess } from './module-access';
import type { ModuleManifest } from './module.model';

const manifest = (over: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id: 'education',
  name: 'Educação',
  description: '',
  icon: 'academic',
  group: 'vertical',
  routes: [],
  permissions: ['education.access'],
  dependencies: ['crm'],
  featureFlag: 'edu.enabled',
  ...over,
});

const state = (moduleId: string, contracted: boolean, active: boolean): TenantModuleState => ({
  moduleId,
  contracted,
  active,
});

function context(over: Partial<ModuleAccessContext> = {}): ModuleAccessContext {
  return {
    tenantModules: [state('education', true, true), state('crm', true, true)],
    isFlagEnabled: () => true,
    can: () => true,
    ...over,
  };
}

describe('resolveModuleAccess', () => {
  it('is accessible when contracted, active, dependencies ready, flag on and permitted', () => {
    expect(resolveModuleAccess(manifest(), context())).toBe('accessible');
  });

  it('reports a module missing from the tenant as not contracted', () => {
    expect(resolveModuleAccess(manifest(), context({ tenantModules: [] }))).toBe('not-contracted');
  });

  it('distinguishes contracted-but-inactive from not contracted', () => {
    const tenantModules = [state('education', true, false), state('crm', true, true)];
    expect(resolveModuleAccess(manifest(), context({ tenantModules }))).toBe('inactive');
  });

  it('requires dependencies to be contracted and active', () => {
    const tenantModules = [state('education', true, true), state('crm', true, false)];
    expect(resolveModuleAccess(manifest(), context({ tenantModules }))).toBe('missing-dependency');
  });

  it('respects the feature flag', () => {
    expect(resolveModuleAccess(manifest(), context({ isFlagEnabled: () => false }))).toBe(
      'flag-disabled',
    );
  });

  it('requires every module permission', () => {
    expect(resolveModuleAccess(manifest(), context({ can: () => false }))).toBe('forbidden');
  });

  it('checks contract before permissions (a user cannot "see" what the tenant lacks)', () => {
    expect(resolveModuleAccess(manifest(), context({ tenantModules: [], can: () => false }))).toBe(
      'not-contracted',
    );
  });
});
