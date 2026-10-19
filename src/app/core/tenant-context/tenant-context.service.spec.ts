import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { PermissionService } from '../permissions/permission.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { TenantContextService } from './tenant-context.service';

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
