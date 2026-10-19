import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { moduleId } from './define-module';
import type { ModuleAccessStatus } from './module-access';
import { TenantModulesService } from './tenant-modules.service';

async function statusesFor(
  email: string,
  slug: string,
): Promise<Record<string, ModuleAccessStatus>> {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const modules = TestBed.inject(TenantModulesService);
  return Object.fromEntries(modules.resolved().map((r) => [r.manifest.code, r.access]));
}

describe('TenantModulesService', () => {
  beforeEach(() => setupMockBackend());

  it('resolves only contractable modules, never foundation capabilities', async () => {
    const statuses = await statusesFor('multi@demo.pt', 'escola-horizonte');
    expect(Object.keys(statuses)).toHaveLength(35);
    expect(statuses['iam.users']).toBeUndefined();
  });

  it('Escola / Secretário: accessible only where contracted, active AND authorized', async () => {
    const s = await statusesFor('multi@demo.pt', 'escola-horizonte');
    expect(s['crm.customers']).toBe('accessible');
    expect(s['hr.employees']).toBe('accessible');
    expect(s['finance.cash-banks']).toBe('forbidden'); // activo, mas sem permissão
    expect(s['finance.receivables-payables']).toBe('inactive'); // contratado, desactivado
    expect(s['crm.campaigns']).toBe('inactive'); // contratado, nunca activado
    expect(s['workflow.rules']).toBe('not-contracted'); // só no plano Enterprise
    expect(s['hr.talent']).toBe('forbidden'); // add-on contratado e activo, sem permissão
  });

  it('Clínica / Administrador: dependencies, flags and the plan restrict even an admin', async () => {
    const s = await statusesFor('multi@demo.pt', 'clinica-vida');
    expect(s['crm.customers']).toBe('accessible');
    expect(s['sales.billing']).toBe('missing-dependency'); // depende de Orçamentos e vendas, desactivado
    expect(s['sales.orders']).toBe('inactive');
    expect(s['crm.campaigns']).toBe('not-contracted'); // Starter não inclui
    expect(s['configuration.forms']).toBe('not-contracted');
  });

  it('shows different module sets per tenant for the same user', async () => {
    await loginAs('multi@demo.pt');
    const ctx = TestBed.inject(TenantContextService);
    const modules = TestBed.inject(TenantModulesService);
    const codes = () => modules.accessible().map((r) => r.manifest.code);

    await firstValueFrom(ctx.activate('escola-horizonte'));
    const escola = codes();
    await firstValueFrom(ctx.activate('clinica-vida'));
    const clinica = codes();

    expect(escola).toContain('hr.employees');
    expect(clinica).not.toContain('hr.employees');
    expect(clinica).toContain('reporting.dashboards');
    expect(escola).not.toContain('reporting.dashboards');
  });

  it('resolves feature availability from tenant enablement, flag and permission', async () => {
    const secretary = await statusesFor('multi@demo.pt', 'escola-horizonte');
    expect(secretary['crm.customers']).toBe('accessible');
    const modules = TestBed.inject(TenantModulesService);
    const crm = moduleId('crm.customers');
    expect(modules.featureStatus(crm, 'import')).toBe('forbidden'); // secretário não gere clientes
    expect(modules.featureStatus(crm, 'dedupe')).toBe('not-enabled');
  });

  it('makes a feature available for an admin when enabled and flag is on', async () => {
    await statusesFor('escola@demo.pt', 'escola-horizonte');
    const modules = TestBed.inject(TenantModulesService);
    expect(modules.featureStatus(moduleId('crm.customers'), 'import')).toBe('available');
  });

  it('reads tenant settings with manifest defaults as fallback', async () => {
    await statusesFor('escola@demo.pt', 'escola-horizonte');
    const modules = TestBed.inject(TenantModulesService);
    expect(modules.settingValue(moduleId('sales.orders'), 'quoteValidityDays')).toBe(15); // do tenant
    expect(modules.settingValue(moduleId('finance.cash-banks'), 'baseCurrency')).toBe('EUR'); // por omissão
  });

  it('exposes nothing without an active tenant', () => {
    expect(TestBed.inject(TenantModulesService).accessible()).toEqual([]);
  });
});
