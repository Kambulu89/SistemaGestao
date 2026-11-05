import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  UrlTree,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { accessGuard, tenantGuard } from './guards';
import { Session, type TenantLink } from './session';
import { Workspace } from './workspace';

const link = (id: string, available = true): TenantLink => ({
  id,
  code: id,
  name: id,
  status: 'ACTIVE',
  membershipStatus: available ? 'ACTIVE' : 'SUSPENDED',
  available,
});

function setup(tenants: TenantLink[], stored: string | null = null) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  TestBed.inject(Session).tenants.set(tenants);
  const workspace = TestBed.inject(Workspace);
  workspace.tenantId.set(stored);
  const select = vi.spyOn(workspace, 'select').mockResolvedValue(undefined);
  return { workspace, select, router: TestBed.inject(Router) };
}

const run = (guard: typeof tenantGuard, data: Record<string, unknown> = {}) =>
  TestBed.runInInjectionContext(() =>
    guard({ data } as unknown as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
  );

describe('tenantGuard', () => {
  it('escolhe automaticamente a única empresa disponível', async () => {
    const { select } = setup([link('a'), link('b', false)]);
    expect(await run(tenantGuard)).toBe(true);
    expect(select).toHaveBeenCalledWith('a');
  });

  it('com várias empresas e nenhuma escolhida vai para a escolha', async () => {
    const { select, router } = setup([link('a'), link('b')]);
    const result = await run(tenantGuard);
    expect(result instanceof UrlTree && router.serializeUrl(result)).toBe('/empresas');
    expect(select).not.toHaveBeenCalled();
  });

  it('ignora uma escolha guardada que já não está disponível', async () => {
    const { select } = setup([link('a'), link('b'), link('c', false)], 'c');
    await run(tenantGuard);
    expect(select).not.toHaveBeenCalled();
  });
});

describe('accessGuard', () => {
  it('nega sem a permissão ou sem a funcionalidade', () => {
    const { workspace, router } = setup([]);
    workspace.permissions.set(new Set(['audit.read']));
    expect(run(accessGuard, { permission: 'audit.read' })).toBe(true);
    const denied = run(accessGuard, { permission: 'roles.read' });
    expect(denied instanceof UrlTree && router.serializeUrl(denied)).toBe('/sem-acesso');
    const noFeature = run(accessGuard, { permission: 'audit.read', feature: 'approvals' });
    expect(noFeature instanceof UrlTree).toBe(true);
  });
});
