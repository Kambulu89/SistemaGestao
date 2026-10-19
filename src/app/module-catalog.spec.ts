import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MODULE_GROUPS } from './core/modules/catalog/module-groups';
import { validateCatalog } from './core/modules/catalog-validation';
import { MODULE_MANIFESTS } from './core/modules/module-manifests.token';
import { ModuleRegistryService } from './core/modules/module-registry.service';
import { MOCK_PLANS, MOCK_SUBSCRIPTIONS, MOCK_TENANT_SETUP } from './core/mock/mock-data';
import { ALL_MODULE_MANIFESTS } from './module-catalog';
import { buildModuleRoutes } from './module-routes';

const contractable = ALL_MODULE_MANIFESTS.filter((m) => m.kind === 'module');
const ids = new Set(ALL_MODULE_MANIFESTS.map((m) => m.id));

describe('official module catalog', () => {
  it('registers the 46 capabilities: 11 foundation + 35 contractable modules', () => {
    expect(ALL_MODULE_MANIFESTS).toHaveLength(46);
    expect(ALL_MODULE_MANIFESTS.filter((m) => m.kind === 'foundation')).toHaveLength(11);
    expect(contractable).toHaveLength(35);
  });

  it('covers the 19 functional groups, none empty', () => {
    expect(MODULE_GROUPS).toHaveLength(19);
    for (const group of MODULE_GROUPS) {
      expect(
        ALL_MODULE_MANIFESTS.some((m) => m.groupId === group.id),
        group.id,
      ).toBe(true);
    }
  });

  it('is internally consistent (ids, codes, groups, dependencies, cycles)', () => {
    expect(validateCatalog(MODULE_GROUPS, ALL_MODULE_MANIFESTS)).toEqual([]);
  });

  it('gives the registry the same verdict', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: MODULE_MANIFESTS, useValue: ALL_MODULE_MANIFESTS }],
    });
    const registry = TestBed.inject(ModuleRegistryService);
    expect(registry.issues).toEqual([]);
    expect(registry.permissionCatalog().length).toBeGreaterThan(70);
  });

  it('keeps technical codes aligned with the group (group.code…)', () => {
    for (const m of ALL_MODULE_MANIFESTS.filter((x) => x.scope === 'tenant')) {
      expect(m.code.startsWith(`${m.groupId}.`), m.code).toBe(true);
    }
  });

  it('has an enterprise plan that includes every contractable module', () => {
    const enterprise = MOCK_PLANS.find((p) => p.code === 'enterprise');
    expect([...(enterprise?.moduleIds ?? [])].sort()).toEqual(contractable.map((m) => m.id).sort());
  });

  it('only references modules that exist in the catalog (plans, subscriptions, tenants)', () => {
    const referenced = [
      ...MOCK_PLANS.flatMap((p) => p.moduleIds),
      ...MOCK_SUBSCRIPTIONS.flatMap((s) => s.moduleIds),
      ...Object.values(MOCK_TENANT_SETUP).flatMap((t) => t.modules.map((m) => m.moduleId)),
    ];
    for (const id of referenced) expect(ids.has(id), id).toBe(true);
  });

  it('never activates a module that the subscription does not include, in the mock data', () => {
    for (const sub of MOCK_SUBSCRIPTIONS) {
      const setup = MOCK_TENANT_SETUP[sub.tenantId];
      for (const m of setup?.modules ?? []) expect(sub.moduleIds, m.moduleId).toContain(m.moduleId);
    }
  });
});

describe('module routes', () => {
  it('generates one lazy, guarded route per contractable tenant module', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const routes = buildModuleRoutes(ALL_MODULE_MANIFESTS);
    expect(routes).toHaveLength(35);
    expect(new Set(routes.map((r) => r.path)).size).toBe(35);
    for (const route of routes) {
      expect(route.canActivate).toHaveLength(1);
      expect(route.data?.['moduleId']).toBeTruthy();
      expect(route.children?.[0]?.loadComponent).toBeTypeOf('function');
    }
  });

  it('does not collide with the tenant administration pages', () => {
    const adminPaths = ['modules', 'organization', 'users', 'permissions', 'settings'];
    for (const route of buildModuleRoutes(ALL_MODULE_MANIFESTS)) {
      expect(adminPaths).not.toContain(route.path);
    }
  });
});
