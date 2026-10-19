import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  type CanActivateFn,
  convertToParamMap,
  type RouterStateSnapshot,
  type UrlTree,
} from '@angular/router';
import { firstValueFrom, isObservable, type Observable } from 'rxjs';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { authGuard, guestGuard } from './auth.guard';
import { homeRedirectGuard } from './home-redirect.guard';
import { moduleGuard } from './module.guard';
import { platformGuard } from './platform.guard';
import { tenantGuard } from './tenant.guard';

async function run(
  guard: CanActivateFn,
  params: Record<string, string> = {},
  url = '/x',
): Promise<boolean | string> {
  const route = { paramMap: convertToParamMap(params) } as ActivatedRouteSnapshot;
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

  it('tenantGuard only admits members of the tenant in the URL', async () => {
    await loginAs('multi@demo.pt');
    expect(await run(tenantGuard, { tenantSlug: 'clinica-vida' })).toBe(true);
    expect(await run(tenantGuard, { tenantSlug: 'transportes-atlas' })).toBe('/auth/no-access');
  });

  it('moduleGuard blocks modules that are not accessible to the user', async () => {
    await loginAs('multi@demo.pt');
    await run(tenantGuard, { tenantSlug: 'escola-horizonte' });
    expect(TestBed.inject(ModuleRegistryService).accessOf('crm')).toBe('accessible');
    expect(await run(moduleGuard, { moduleId: 'crm' })).toBe(true);
    expect(await run(moduleGuard, { moduleId: 'finance' })).toBe('/auth/no-access');
    expect(await run(moduleGuard, { moduleId: 'unknown' })).toBe('/auth/no-access');
  });

  it('moduleGuard also enforces the permission of a module section', async () => {
    await loginAs('multi@demo.pt');
    await run(tenantGuard, { tenantSlug: 'escola-horizonte' });
    expect(await run(moduleGuard, { moduleId: 'crm', section: 'contacts' })).toBe(true);
    expect(await run(moduleGuard, { moduleId: 'crm', section: 'accounts' })).toBe(
      '/auth/no-access',
    );
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
});
