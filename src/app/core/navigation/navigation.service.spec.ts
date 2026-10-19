import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { NavigationService } from './navigation.service';

async function labelsFor(slug: string): Promise<string[]> {
  await firstValueFrom(TestBed.inject(ModuleRegistryService).ensureCatalog());
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  return TestBed.inject(NavigationService)
    .tenantNav()
    .flatMap((g) => g.items.map((i) => i.label));
}

describe('NavigationService', () => {
  beforeEach(() => setupMockBackend());

  it('limits a Secretário to what is contracted, active, enabled AND permitted', async () => {
    await loginAs('multi@demo.pt');
    // Escola: Financeiro está contratado mas o papel não o permite; RH está desactivado.
    expect(await labelsFor('escola-horizonte')).toEqual([
      'Painel',
      'Organização',
      'CRM',
      'Educação',
    ]);
  });

  it('hides inactive modules and flagged-off features for an admin', async () => {
    await loginAs('multi@demo.pt');
    // Clínica: Financeiro inactivo; Formulários dinâmicos com a flag desligada.
    expect(await labelsFor('clinica-vida')).toEqual([
      'Painel',
      'Organização',
      'Utilizadores',
      'Configurações',
      'CRM',
      'Workflows',
      'Saúde',
    ]);
  });

  it('builds tenant links under /t/:slug', async () => {
    await loginAs('multi@demo.pt');
    await labelsFor('escola-horizonte');
    const paths = TestBed.inject(NavigationService)
      .tenantNav()
      .flatMap((g) => g.items.map((i) => i.path));
    expect(paths).toContain('/t/escola-horizonte/modules/crm');
  });

  it('shows the platform menu to platform admins', async () => {
    await loginAs('plataforma@demo.pt');
    const labels = TestBed.inject(NavigationService)
      .platformNav()
      .flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toEqual(['Painel', 'Tenants', 'Planos', 'Subscrições']);
  });
});
