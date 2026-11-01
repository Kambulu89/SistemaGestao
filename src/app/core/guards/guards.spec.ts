import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  type CanActivateFn,
  convertToParamMap,
  type RouterStateSnapshot,
  type UrlTree,
} from '@angular/router';
import { firstValueFrom, isObservable, type Observable, throwError } from 'rxjs';
import { TenantGateway } from '../tenant-context/tenant.gateway';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { moduleId } from '../modules/define-module';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { DynamicEntityRegistryService } from '../dynamic/entity-registry.service';
import { authGuard, guestGuard } from './auth.guard';
import { requireEntityOperation } from './entity.guard';
import { homeRedirectGuard } from './home-redirect.guard';
import { moduleGuard } from './module.guard';
import { platformGuard } from './platform.guard';
import { tenantGuard } from './tenant.guard';

async function run(
  guard: CanActivateFn,
  params: Record<string, string> = {},
  url = '/x',
  data: Record<string, unknown> = {},
): Promise<boolean | string> {
  const route = { paramMap: convertToParamMap(params), data } as ActivatedRouteSnapshot;
  const result = TestBed.runInInjectionContext(() => guard(route, { url } as RouterStateSnapshot));
  const value = isObservable(result) ? await firstValueFrom(result as Observable<unknown>) : result;
  return typeof value === 'boolean' ? value : (value as UrlTree).toString();
}

describe('guards', () => {
  beforeEach(() => setupMockBackend());

  it('authGuard sends anonymous users to login keeping the returnUrl', async () => {
    expect(await run(authGuard, {}, '/t/a/users')).toBe('/auth/login?returnUrl=%2Ft%2Fa%2Fusers');
  });

  it('authGuard / guestGuard follow the session', async () => {
    await loginAs('multi@demo.pt');
    expect(await run(authGuard)).toBe(true);
    expect(await run(guestGuard)).toBe('/');
  });

  it('platformGuard blocks tenant-only users and allows platform admins', async () => {
    await loginAs('multi@demo.pt');
    expect(await run(platformGuard)).toBe('/auth/no-access');
  });

  it('platformGuard leaves the tenant context so a stale tenant is never sent', async () => {
    await loginAs('plataforma@demo.pt');
    const ctx = TestBed.inject(TenantContextService);
    await firstValueFrom(ctx.activate('escola-horizonte'));
    expect(await run(platformGuard)).toBe(true);
    expect(ctx.active()).toBeNull();
  });

  it('tenantGuard sends the user to no-access when the server refuses the tenant (e.g. suspended)', async () => {
    await loginAs('multi@demo.pt');
    vi.spyOn(TestBed.inject(TenantGateway), 'loadContext').mockReturnValue(
      throwError(() => ({
        status: 403,
        code: 'TENANT_NOT_ACTIVE',
        message: 'O tenant não está activo.',
      })),
    );
    expect(await run(tenantGuard, { tenantSlug: 'escola-horizonte' })).toBe('/auth/no-access');
  });

  it('tenantGuard only admits members of the tenant in the URL', async () => {
    await loginAs('multi@demo.pt');
    expect(await run(tenantGuard, { tenantSlug: 'clinica-vida' })).toBe(true);
    expect(await run(tenantGuard, { tenantSlug: 'transportes-atlas' })).toBe('/auth/no-access');
  });

  it('moduleGuard only admits modules that are accessible to the user in the active tenant', async () => {
    await loginAs('multi@demo.pt');
    await run(tenantGuard, { tenantSlug: 'escola-horizonte' }); // Secretário
    const data = (code: string) => ({ moduleId: moduleId(code) });

    expect(await run(moduleGuard, {}, '/x', data('crm.customers'))).toBe(true);
    expect(await run(moduleGuard, {}, '/x', data('finance.cash-banks'))).toBe('/auth/no-access'); // sem permissão
    expect(await run(moduleGuard, {}, '/x', data('finance.receivables-payables'))).toBe(
      '/auth/no-access',
    ); // inactivo
    expect(await run(moduleGuard, {}, '/x', data('workflow.rules'))).toBe('/auth/no-access'); // não contratado
    expect(await run(moduleGuard, {}, '/x', { moduleId: 'mod_unknown' })).toBe('/auth/no-access');
    expect(await run(moduleGuard, {}, '/x', {})).toBe('/auth/no-access');
  });

  it('homeRedirectGuard picks login, platform or tenant', async () => {
    expect(await run(homeRedirectGuard)).toBe('/auth/login');
    await loginAs('multi@demo.pt');
    expect(await run(homeRedirectGuard)).toBe('/t/escola-horizonte');
  });

  it('homeRedirectGuard sends platform admins to /platform', async () => {
    await loginAs('plataforma@demo.pt');
    expect(await run(homeRedirectGuard)).toBe('/platform');
  });

  it('requireEntityOperation admits only entities the user may operate on (RBAC + module + tenant)', async () => {
    await loginAs('operador@demo.pt');
    expect(await run(tenantGuard, { tenantSlug: 'transportes-atlas' })).toBe(true); // carrega as definições
    const guard = (op: Parameters<typeof requireEntityOperation>[0]) => requireEntityOperation(op);
    const params = (entityKey: string) => ({ entityKey });

    expect(await run(guard('read'), params('vehicle'))).toBe(true);
    expect(await run(guard('update'), params('vehicle'))).toBe(true);
    expect(await run(guard('create'), params('driver'))).toBe('/auth/no-access'); // só lê condutores
    expect(await run(guard('read'), params('ghost'))).toBe('/auth/no-access'); // desconhecida = proibida
    expect(TestBed.inject(DynamicEntityRegistryService).find('vehicle')).toBeDefined();
  });

  it('requireEntityOperation hides entities of other tenants', async () => {
    await loginAs('escola@demo.pt');
    await run(tenantGuard, { tenantSlug: 'escola-horizonte' });
    expect(await run(requireEntityOperation('read'), { entityKey: 'note' })).toBe(true);
    expect(await run(requireEntityOperation('read'), { entityKey: 'vehicle' })).toBe(
      '/auth/no-access',
    );
  });
});
