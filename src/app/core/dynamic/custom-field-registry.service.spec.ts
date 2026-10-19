import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { EntityRecordsGateway } from './data-access/entity-records.gateway';
import { CustomFieldRegistryService } from './custom-field-registry.service';
import { DynamicEntityRegistryService } from './entity-registry.service';

async function enter(email: string, slug: string) {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const registry = TestBed.inject(DynamicEntityRegistryService);
  await firstValueFrom(registry.ensureLoaded());
  return { registry, api: TestBed.inject(EntityRecordsGateway) };
}

const Q = { page: 1, pageSize: 20 };
const keysOf = (r: DynamicEntityRegistryService, entity: string) =>
  r.find(entity)?.fields.map((f) => f.key);
const fails = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('Era esperado um erro.');
};

describe('Custom fields: registo e isolamento (caso A)', () => {
  beforeEach(() => setupMockBackend());

  it('Tenant A merges only its own active custom fields into the native entity', async () => {
    const { registry } = await enter('escola@demo.pt', 'escola-horizonte');
    expect(keysOf(registry, 'customer')).toEqual([
      'nome',
      'email',
      'telefone',
      'sectorActividade',
      'nifSecundario',
      'categoriaCliente',
      'dataRenovacao',
    ]);
    const custom = registry.find('customer')!.fields.filter((f) => f.origin === 'custom');
    expect(custom).toHaveLength(4);
  });

  it('Tenant B gets different fields and never sees those of tenant A', async () => {
    const { registry } = await enter('frota@demo.pt', 'transportes-atlas');
    expect(keysOf(registry, 'customer')).toEqual([
      'nome',
      'email',
      'telefone',
      'regiaoComercial',
      'codigoInterno',
    ]);
  });

  it('never mixes custom fields when the active tenant changes', async () => {
    await loginAs('multi@demo.pt');
    const ctx = TestBed.inject(TenantContextService);
    const registry = TestBed.inject(DynamicEntityRegistryService);
    await firstValueFrom(ctx.activate('escola-horizonte'));
    await firstValueFrom(registry.ensureLoaded());
    expect(keysOf(registry, 'customer')).toContain('sectorActividade');

    await firstValueFrom(ctx.activate('clinica-vida'));
    await firstValueFrom(registry.ensureLoaded());
    expect(keysOf(registry, 'customer')).toEqual(['nome', 'email', 'telefone']);
  });

  it('keeps archived fields out of the entity but in the registry', async () => {
    const { registry } = await enter('escola@demo.pt', 'escola-horizonte');
    expect(keysOf(registry, 'customer')).not.toContain('faxAntigo');
    const all = TestBed.inject(CustomFieldRegistryService).forEntity({
      kind: 'core',
      key: 'customer',
    });
    expect(all.map((c) => c.field.key)).toContain('faxAntigo');
  });

  it('does not alter the native definition shared by tenants', async () => {
    await enter('escola@demo.pt', 'escola-horizonte');
    const { CUSTOMER_V1 } = await import('../mock/mock-entities');
    expect(CUSTOMER_V1.fields.map((f) => f.key)).toEqual(['nome', 'email', 'telefone']);
  });
});

describe('Custom fields: servidor mock', () => {
  beforeEach(() => setupMockBackend());

  it('returns custom values and the list columns of the tenant', async () => {
    const { registry, api } = await enter('escola@demo.pt', 'escola-horizonte');
    const page = await firstValueFrom(api.list('customer', Q));
    expect(page.total).toBe(4);
    expect(page.items[0]?.data['sectorActividade']).toBeDefined();
    expect(registry.find('customer')!.list.columns.map((c) => c.field)).toContain(
      'sectorActividade',
    );
  });

  it('strips sensitive fields from users without the sensitive permission', async () => {
    const { api } = await enter('multi@demo.pt', 'escola-horizonte'); // Secretário
    const page = await firstValueFrom(api.list('customer', Q));
    for (const r of page.items) expect(r.data).not.toHaveProperty('nifSecundario');
    expect(page.items.some((r) => r.data['sectorActividade'])).toBe(true);
  });

  it('keeps sensitive fields for the admin', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const page = await firstValueFrom(api.list('customer', Q));
    expect(page.items.some((r) => r.data['nifSecundario'] === '501234567')).toBe(true);
  });

  it('never returns data of archived fields', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const page = await firstValueFrom(api.list('customer', Q));
    for (const r of page.items) expect(r.data).not.toHaveProperty('faxAntigo');
  });

  it('preserves archived field data when the record is updated', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const page = await firstValueFrom(api.list('customer', Q));
    const target = page.items.find((r) => r.data['nome'] === 'Papelaria Central')!;
    await firstValueFrom(
      api.update('customer', target.id, {
        expectedRowVersion: target.rowVersion,
        data: { nome: 'Papelaria Nova' },
      }),
    );
    // O mesmo registo continua a guardar o valor arquivado (apenas não é exposto).
    const store = TestBed.inject(EntityRecordsGateway) as unknown as {
      records: Map<string, { id: string; data: Record<string, unknown> }[]>;
    };
    const stored = store.records.get('t-escola:customer')!.find((r) => r.id === target.id)!;
    expect(stored.data['faxAntigo']).toBe('213 000 112');
  });

  it('rejects filtering or sorting by a field the user cannot read', async () => {
    const { api } = await enter('multi@demo.pt', 'escola-horizonte');
    const byFilter = await fails(
      firstValueFrom(api.list('customer', { ...Q, filters: { nifSecundario: '501234567' } })),
    );
    expect(byFilter.status).toBe(403);
    const bySort = await fails(
      firstValueFrom(
        api.list('customer', { ...Q, sort: { key: 'nifSecundario', direction: 'asc' } }),
      ),
    );
    expect(bySort.status).toBe(403);
  });

  it('refuses writing a sensitive field without the sensitive permission', async () => {
    const { api } = await enter('multi@demo.pt', 'escola-horizonte');
    const error = await fails(
      firstValueFrom(api.create('customer', { data: { nome: 'X', nifSecundario: '123456789' } })),
    );
    expect(error.status).toBe(422);
  });

  it('enforces uniqueness of custom fields per tenant', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const error = await fails(
      firstValueFrom(api.create('customer', { data: { nome: 'Dup', nifSecundario: '501234567' } })),
    );
    expect(error.status).toBe(422);
    // O mesmo valor noutro tenant não colide (campo diferente/isolado).
  });

  it('rejects values for custom fields of another tenant', async () => {
    const { api } = await enter('frota@demo.pt', 'transportes-atlas');
    const error = await fails(
      firstValueFrom(api.create('customer', { data: { nome: 'Y', sectorActividade: 'saude' } })),
    );
    expect(error.status).toBe(422);
  });

  it('accepts a valid custom value and rejects an invalid option', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const ok = await firstValueFrom(
      api.create('customer', {
        data: { nome: 'Novo', sectorActividade: 'saude', categoriaCliente: 'A' },
      }),
    );
    expect(ok.data['sectorActividade']).toBe('saude');
    const bad = await fails(
      firstValueFrom(api.create('customer', { data: { nome: 'Z', categoriaCliente: 'Q' } })),
    );
    expect(bad.status).toBe(422);
  });
});
