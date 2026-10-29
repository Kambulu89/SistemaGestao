import { type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { DynamicEntityRegistryService } from '../../core/dynamic/entity-registry.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../../core/testing/test-backend';
import { TenantDashboard } from './dashboard/tenant-dashboard';
import { TenantPermissionsPage } from './permissions/tenant-permissions-page';

let lastFixture: ComponentFixture<unknown> | undefined;

async function render(component: Type<unknown>, email: string, slug: string): Promise<HTMLElement> {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  // O `tenantGuard` carrega as definições ao entrar no tenant.
  await firstValueFrom(TestBed.inject(DynamicEntityRegistryService).ensureLoaded());
  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  lastFixture = fixture;
  return fixture.nativeElement as HTMLElement;
}

describe('tenant pages', () => {
  beforeEach(() => setupMockBackend());

  it('dashboard shows subscription, role and plan limits', async () => {
    const el = await render(TenantDashboard, 'multi@demo.pt', 'escola-horizonte');
    expect(el.querySelector('h1')?.textContent).toContain('Escola Horizonte');
    expect(el.textContent).toContain('business');
    expect(el.textContent).toContain('Secretário');
    expect(el.textContent).toContain('10 regras de permissão');
    expect(el.textContent).toContain('62 / 100');
    expect(el.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('62');
  });

  it('dashboard summarises full access for an admin', async () => {
    const el = await render(TenantDashboard, 'escola@demo.pt', 'escola-horizonte');
    expect(el.textContent).toContain('Acesso total à organização');
  });

  it('permissions page shows which permissions the current role grants', async () => {
    const el = await render(TenantPermissionsPage, 'multi@demo.pt', 'escola-horizonte');
    const row = [...el.querySelectorAll('tr')].find((r) =>
      r.textContent?.includes('crm.customers.read'),
    );
    expect(row?.textContent).toContain('Concedida');
    const denied = [...el.querySelectorAll('tr')].find((r) =>
      r.textContent?.includes('finance.payments-budget.read'),
    );
    expect(denied?.textContent).toContain('Não concedida');
  });

  it('permissions page only lists tenant-scope capabilities', async () => {
    const el = await render(TenantPermissionsPage, 'escola@demo.pt', 'escola-horizonte');
    expect(el.textContent).not.toContain('platform.tenants.read');
  });

  it('permissions page also lists the dynamic entity permissions (same IAM keys)', async () => {
    const el = await render(TenantPermissionsPage, 'frota@demo.pt', 'transportes-atlas');
    // Quem gere acessos abre no separador dos perfis: o catálogo está no seu próprio separador.
    el.querySelector<HTMLButtonElement>('[data-testid=tab-catalog]')?.click();
    lastFixture?.detectChanges();
    await lastFixture?.whenStable();
    lastFixture?.detectChanges();
    expect(el.textContent).toContain('Entidade: Viaturas');
    const row = [...el.querySelectorAll('tr')].find((r) =>
      r.textContent?.includes('entities.vehicle.delete'),
    );
    expect(row?.textContent).toContain('Concedida');
  });

  it('shows the operator only the entity permissions the role grants', async () => {
    const el = await render(TenantPermissionsPage, 'operador@demo.pt', 'transportes-atlas');
    const state = (key: string) =>
      [...el.querySelectorAll('tr')].find((r) => r.textContent?.includes(key))?.textContent;
    expect(state('entities.vehicle.update')).toContain('Concedida');
    expect(state('entities.vehicle.delete')).toContain('Não concedida');
  });
});
