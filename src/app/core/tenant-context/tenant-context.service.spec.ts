import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { PermissionService } from '../permissions/permission.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { TENANT_SCOPE_RESETTERS, TenantContextService } from './tenant-context.service';
import { TenantGateway } from './tenant.gateway';

describe('TenantContextService', () => {
  beforeEach(async () => {
    setupMockBackend();
    await loginAs('multi@demo.pt');
  });

  it('lists only the tenants the user belongs to', async () => {
    const list = await firstValueFrom(TestBed.inject(TenantContextService).loadMemberships());
    expect(list.map((m) => m.tenant.slug)).toEqual(['escola-horizonte', 'clinica-vida']);
  });

  it('activates a tenant and exposes the role-specific permissions', async () => {
    const ctx = TestBed.inject(TenantContextService);
    const perms = TestBed.inject(PermissionService);

    await firstValueFrom(ctx.activate('escola-horizonte'));
    expect(ctx.active()?.roleName).toBe('Secretário');
    expect(perms.can('tenant.users.read')).toBe(false);

    await firstValueFrom(ctx.activate('clinica-vida'));
    expect(ctx.active()?.roleName).toBe('Administrador');
    expect(perms.can('tenant.users.read')).toBe(true);
  });

  it('refuses a tenant the user does not belong to', async () => {
    const ctx = TestBed.inject(TenantContextService);
    expect(await firstValueFrom(ctx.activate('transportes-atlas'))).toBeNull();
    expect(ctx.active()).toBeNull();
  });

  it('clears everything on logout', async () => {
    const ctx = TestBed.inject(TenantContextService);
    await firstValueFrom(ctx.activate('escola-horizonte'));
    TestBed.inject(AuthService).logout();
    TestBed.tick();
    expect(ctx.active()).toBeNull();
    expect(ctx.memberships()).toEqual([]);
  });
});

describe('TenantContextService tenant switch', () => {
  it('runs the registered resetters when the tenant changes and when the session ends', async () => {
    const reset = vi.fn();
    setupMockBackend();
    TestBed.configureTestingModule({
      providers: [{ provide: TENANT_SCOPE_RESETTERS, useValue: [reset] }],
    });
    await loginAs('multi@demo.pt');
    const ctx = TestBed.inject(TenantContextService);

    await firstValueFrom(ctx.activate('escola-horizonte'));
    expect(reset).not.toHaveBeenCalled(); // primeira activação: nada a limpar

    await firstValueFrom(ctx.activate('clinica-vida'));
    expect(reset).toHaveBeenCalledTimes(1);

    TestBed.inject(AuthService).logout();
    TestBed.tick();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('emits switched$ on a switch, not when re-activating the same tenant', async () => {
    setupMockBackend();
    await loginAs('multi@demo.pt');
    const ctx = TestBed.inject(TenantContextService);
    const emitted = vi.fn();
    ctx.switched$.subscribe(emitted);

    await firstValueFrom(ctx.activate('escola-horizonte'));
    await firstValueFrom(ctx.activate('escola-horizonte'));
    expect(emitted).not.toHaveBeenCalled();

    await firstValueFrom(ctx.activate('clinica-vida'));
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('refreshMemberships asks the server again', async () => {
    setupMockBackend();
    await loginAs('multi@demo.pt');
    const ctx = TestBed.inject(TenantContextService);
    await firstValueFrom(ctx.loadMemberships());
    const spy = vi.spyOn(TestBed.inject(TenantGateway), 'listMemberships');
    await firstValueFrom(ctx.loadMemberships());
    expect(spy).not.toHaveBeenCalled(); // em cache
    await firstValueFrom(ctx.refreshMemberships());
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
