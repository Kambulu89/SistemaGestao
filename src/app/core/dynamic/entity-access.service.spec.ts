import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { EntityAccessService } from './entity-access.service';
import { DynamicEntityRegistryService } from './entity-registry.service';

async function enter(email: string, slug: string) {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const registry = TestBed.inject(DynamicEntityRegistryService);
  await firstValueFrom(registry.ensureLoaded());
  return { registry, access: TestBed.inject(EntityAccessService) };
}

describe('EntityAccessService', () => {
  beforeEach(() => setupMockBackend());

  it('lets an admin do everything the policies allow', async () => {
    const { registry, access } = await enter('frota@demo.pt', 'transportes-atlas');
    const vehicle = registry.find('vehicle')!;
    for (const op of ['read', 'create', 'update', 'export', 'approve', 'transition'] as const) {
      expect(access.can(vehicle, op), op).toBe(true);
    }
  });

  it('applies the ABAC policy even to an admin: delete only when inactive', async () => {
    const { registry, access } = await enter('frota@demo.pt', 'transportes-atlas');
    const vehicle = registry.find('vehicle')!;
    expect(access.check(vehicle, 'delete', { status: 'available', data: {} })).toMatchObject({
      allowed: false,
      denied: 'policy',
    });
    expect(access.check(vehicle, 'delete', { status: 'inactive', data: {} }).allowed).toBe(true);
  });

  it('restricts an operator to the permissions the IAM role grants', async () => {
    const { registry, access } = await enter('operador@demo.pt', 'transportes-atlas');
    const vehicle = registry.find('vehicle')!;
    expect(access.can(vehicle, 'read')).toBe(true);
    expect(access.can(vehicle, 'update')).toBe(true);
    expect(access.can(vehicle, 'delete')).toBe(false);
    expect(access.can(vehicle, 'approve')).toBe(false);
    expect(access.can(registry.find('driver')!, 'create')).toBe(false);
  });

  it('lists only the entities the user may read', async () => {
    const operator = await enter('operador@demo.pt', 'transportes-atlas');
    expect(operator.access.readable().map((e) => e.key)).toEqual([
      'customer',
      'driver',
      'note',
      'vehicle',
    ]);
  });

  it('shows nothing to a user whose role has no entity permissions', async () => {
    const { access } = await enter('plataforma@demo.pt', 'escola-horizonte'); // suporte, sem entidades
    expect(access.readable()).toEqual([]);
  });

  it('hides everything when the origin module is not contracted, even for an admin', async () => {
    const { registry, access } = await enter('multi@demo.pt', 'clinica-vida'); // Clínica: sem o módulo, '*' nas permissões
    const note = registry.find('note')!;
    expect(access.isAvailable(note)).toBe(false);
    expect(access.check(note, 'read')).toEqual({ allowed: false, denied: 'module' });
    expect(access.readable().map((e) => e.key)).toEqual(['customer']); // o módulo CRM está contratado
  });

  it('shares global entities with tenants that have the module', async () => {
    const { access } = await enter('escola@demo.pt', 'escola-horizonte');
    expect(access.readable().map((e) => e.key)).toEqual(['customer', 'note']);
  });
});
