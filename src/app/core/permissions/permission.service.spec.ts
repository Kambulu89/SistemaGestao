import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { PermissionService } from './permission.service';

describe('PermissionService', () => {
  beforeEach(() => setupMockBackend());

  it('applies the role of the active tenant, per tenant', async () => {
    await loginAs('multi@demo.pt');
    const ctx = TestBed.inject(TenantContextService);
    const perms = TestBed.inject(PermissionService);

    await firstValueFrom(ctx.activate('escola-horizonte')); // Secretário
    expect(perms.can('crm.customers.read')).toBe(true);
    expect(perms.can('iam.users.read')).toBe(false);

    await firstValueFrom(ctx.activate('clinica-vida')); // Administrador
    expect(perms.can('iam.users.read')).toBe(true);
  });

  it('never lets a tenant wildcard grant platform permissions', async () => {
    await loginAs('multi@demo.pt');
    await firstValueFrom(TestBed.inject(TenantContextService).activate('clinica-vida')); // permissions: ['*']
    const perms = TestBed.inject(PermissionService);
    expect(perms.can('crm.customers.read')).toBe(true);
    expect(perms.can('platform.access')).toBe(false);
    expect(perms.can('platform.tenants.read')).toBe(false);
  });

  it('grants platform permissions only from the platform session', async () => {
    await loginAs('plataforma@demo.pt');
    const perms = TestBed.inject(PermissionService);
    expect(perms.can('platform.tenants.read')).toBe(true);
    expect(perms.can('crm.customers.read')).toBe(false); // sem tenant activo
  });

  it('canAll requires every permission', async () => {
    await loginAs('multi@demo.pt');
    await firstValueFrom(TestBed.inject(TenantContextService).activate('escola-horizonte'));
    const perms = TestBed.inject(PermissionService);
    expect(perms.canAll(['crm.customers.read', 'crm.pipeline.read'])).toBe(true);
    expect(perms.canAll(['crm.customers.read', 'iam.users.read'])).toBe(false);
  });
});
