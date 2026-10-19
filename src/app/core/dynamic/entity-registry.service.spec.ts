import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { NOTE_V1, VEHICLE_V2 } from '../mock/mock-entities';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { EntityDefinitionGateway } from './data-access/entity-definition.gateway';
import { DynamicEntityRegistryService } from './entity-registry.service';

async function enter(email: string, slug: string): Promise<DynamicEntityRegistryService> {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const registry = TestBed.inject(DynamicEntityRegistryService);
  await firstValueFrom(registry.ensureLoaded());
  return registry;
}

describe('DynamicEntityRegistryService', () => {
  beforeEach(() => setupMockBackend());

  it('resolves the published definitions of the active tenant (global + own)', async () => {
    const registry = await enter('frota@demo.pt', 'transportes-atlas');
    expect(registry.published().map((d) => d.names.plural)).toEqual([
      'Condutores',
      'Notas',
      'Viaturas',
    ]);
    expect(registry.find('vehicle')?.version).toBe(2);
  });

  it('keeps every version for history, newest first', async () => {
    const registry = await enter('frota@demo.pt', 'transportes-atlas');
    expect(registry.versionsOf('vehicle').map((d) => [d.version, d.state])).toEqual([
      [2, 'published'],
      [1, 'archived'],
    ]);
  });

  it('isolates tenants: another tenant only gets the global entities', async () => {
    const registry = await enter('escola@demo.pt', 'escola-horizonte');
    expect(registry.published().map((d) => d.key)).toEqual(['note']);
    expect(registry.find('vehicle')).toBeUndefined();
    expect(registry.versionsOf('vehicle')).toEqual([]);
  });

  it('never mixes definitions when the active tenant changes', async () => {
    await loginAs('multi@demo.pt');
    const ctx = TestBed.inject(TenantContextService);
    const registry = TestBed.inject(DynamicEntityRegistryService);

    await firstValueFrom(ctx.activate('escola-horizonte'));
    await firstValueFrom(registry.ensureLoaded());
    expect(registry.published()).toHaveLength(1);

    await firstValueFrom(ctx.activate('clinica-vida'));
    expect(registry.published()).toEqual([]); // ainda não carregadas para este tenant
    await firstValueFrom(registry.ensureLoaded());
    expect(registry.published().map((d) => d.key)).toEqual(['note']);
  });

  it('ignores definitions of another tenant even if the server returns them', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: EntityDefinitionGateway, useValue: { list: () => of([VEHICLE_V2, NOTE_V1]) } },
      ],
    });
    const registry = await enter('escola@demo.pt', 'escola-horizonte'); // tenant ≠ t-atlas
    expect(registry.published().map((d) => d.key)).toEqual(['note']);
    expect(registry.all().map((d) => d.key)).toEqual(['note']);
  });

  it('loads once per tenant', async () => {
    let calls = 0;
    TestBed.configureTestingModule({
      providers: [
        { provide: EntityDefinitionGateway, useValue: { list: () => (calls++, of([NOTE_V1])) } },
      ],
    });
    const registry = await enter('escola@demo.pt', 'escola-horizonte');
    await firstValueFrom(registry.ensureLoaded());
    expect(calls).toBe(1);
    registry.reload();
    await firstValueFrom(registry.ensureLoaded());
    expect(calls).toBe(2);
  });

  it('clears everything on logout', async () => {
    const registry = await enter('frota@demo.pt', 'transportes-atlas');
    TestBed.inject(AuthService).logout();
    TestBed.tick();
    expect(registry.published()).toEqual([]);
  });

  it('reports no integrity errors for the reference entities (including cross-entity references)', async () => {
    const registry = await enter('frota@demo.pt', 'transportes-atlas');
    for (const [key, issues] of registry.issues()) {
      expect(
        issues.filter((i) => i.severity === 'error'),
        key,
      ).toEqual([]);
    }
  });

  it('flags a reference to an entity the tenant does not have', async () => {
    const registry = await enter('frota@demo.pt', 'transportes-atlas');
    expect(registry.issues().get('driver')).toBeDefined();
    // A Nota (global) não referencia nada; o Condutor referencia `vehicle`, que existe.
    expect(registry.issues().get('note')).toEqual([]);
  });
});
