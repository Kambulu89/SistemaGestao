import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { DynamicEntityRegistryService } from '../dynamic/entity-registry.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { NavigationService } from './navigation.service';

async function nav(slug: string) {
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  // O `tenantGuard` carrega as definições ao entrar no tenant.
  await firstValueFrom(TestBed.inject(DynamicEntityRegistryService).ensureLoaded());
  return TestBed.inject(NavigationService).tenantNav();
}
const labels = (groups: readonly { items: readonly { label: string }[] }[]) =>
  groups.flatMap((g) => g.items.map((i) => i.label));

describe('NavigationService', () => {
  beforeEach(() => setupMockBackend());

  it('builds the Secretário menu from accessible modules only', async () => {
    await loginAs('multi@demo.pt');
    // Sem permissão de ler os módulos nem o plano, essas entradas não aparecem.
    expect(labels(await nav('escola-horizonte'))).toEqual([
      'Painel',
      'Organização',
      'Configurações',
      'Clientes',
      'Clientes e contactos',
      'Leads e oportunidades',
      'Colaboradores e contratos',
      'DMS e anexos',
      'Calendário e agendamentos',
    ]);
  });

  it('builds a different menu for the same user in another tenant', async () => {
    await loginAs('multi@demo.pt');
    expect(labels(await nav('clinica-vida'))).toEqual([
      'Painel',
      'Módulos',
      'Plano',
      'Organização',
      'Utilizadores',
      'Permissões',
      'Configurações',
      'Entidades',
      'Clientes',
      'Clientes e contactos',
      'Leads e oportunidades',
      'DMS e anexos',
      'Calendário e agendamentos',
      'Dashboards e KPI',
    ]);
  });

  it('groups module entries under the catalog groups, in catalog order', async () => {
    await loginAs('multi@demo.pt');
    const groups = await nav('clinica-vida');
    expect(groups.map((g) => g.label).filter(Boolean)).toEqual([
      'Dados',
      'CRM',
      'Documentos',
      'Agenda',
      'Reporting',
    ]);
  });

  it('links modules under /t/:slug/<basePath>', async () => {
    await loginAs('multi@demo.pt');
    const paths = (await nav('escola-horizonte')).flatMap((g) => g.items.map((i) => i.path));
    expect(paths).toContain('/t/escola-horizonte/crm/customers');
  });

  it('never lists foundation capabilities as module entries', async () => {
    await loginAs('escola@demo.pt');
    const all = labels(await nav('escola-horizonte'));
    expect(all).not.toContain('Autenticação');
    expect(all).not.toContain('Auditoria e logs');
  });

  it('lists the dynamic entities of the tenant in a "Dados" group, per permission', async () => {
    await loginAs('operador@demo.pt');
    const groups = await nav('transportes-atlas');
    const data = groups.find((g) => g.id === 'data');
    expect(data?.label).toBe('Dados');
    expect(data?.items.map((i) => [i.label, i.path])).toEqual([
      ['Clientes', '/t/transportes-atlas/data/customer'],
      ['Condutores', '/t/transportes-atlas/data/driver'],
      ['Notas', '/t/transportes-atlas/data/note'],
      ['Viaturas', '/t/transportes-atlas/data/vehicle'],
    ]);
  });

  it('shows no "Dados" group when the role grants no entity access', async () => {
    await loginAs('plataforma@demo.pt');
    expect((await nav('escola-horizonte')).some((g) => g.id === 'data')).toBe(false);
  });

  it('shows the platform menu to platform admins', async () => {
    await loginAs('plataforma@demo.pt');
    expect(labels(TestBed.inject(NavigationService).platformNav())).toEqual([
      'Painel',
      'Tenants',
      'Catálogo de módulos',
      'Planos',
      'Subscrições',
    ]);
  });
});
