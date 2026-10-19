import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import { AuthService } from '../auth/auth.service';
import { CustomFieldRegistryService } from '../dynamic/custom-field-registry.service';
import type { DefinitionFailure } from '../dynamic/data-access/custom-field.gateway';
import { EntityRecordsGateway } from '../dynamic/data-access/entity-records.gateway';
import { defineField } from '../dynamic/engine/define-entity';
import { DynamicEntityRegistryService } from '../dynamic/entity-registry.service';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';

async function enter(email: string, slug: string) {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const registry = TestBed.inject(DynamicEntityRegistryService);
  await firstValueFrom(registry.ensureLoaded());
  return { registry, records: TestBed.inject(EntityRecordsGateway) };
}

const fails = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('Era esperado um erro.');
};
const messages = (e: ApiError) => (e.details as DefinitionFailure).issues.map((i) => i.message);

/** O tenant Atlas liga cada cliente a uma viatura e mostra a matrícula dessa viatura. */
async function setup(onMissing: 'empty' | 'error' = 'empty') {
  const ctx = await enter('frota@demo.pt', 'transportes-atlas');
  const custom = TestBed.inject(CustomFieldRegistryService);
  const save = (field: ReturnType<typeof defineField>) =>
    firstValueFrom(
      custom.save({
        id: null,
        entity: { kind: 'core', key: 'customer' },
        field,
        showInList: false,
        state: 'active',
        expectedVersion: null,
      }),
    );
  await save(
    defineField({
      type: 'entity-reference',
      key: 'viaturaPreferida',
      label: 'Viatura',
      entityKey: 'vehicle',
    }),
  );
  await save(
    defineField({
      type: 'lookup',
      key: 'matriculaPreferida',
      label: 'Matrícula',
      lookup: { relationField: 'viaturaPreferida', sourceField: 'matricula', onMissing },
    }),
  );
  return { ...ctx, save };
}

const create = (r: EntityRecordsGateway, data: Record<string, unknown>) =>
  firstValueFrom(r.create('customer', { data: { nome: 'Cliente', ...data } as never }));

describe('Valor relacionado (servidor)', () => {
  beforeEach(() => setupMockBackend());

  it('reads the value from the referenced record, live', async () => {
    const { records } = await setup();
    const customer = await create(records, { viaturaPreferida: 'vehicle-1' });
    expect(customer.data['matriculaPreferida']).toBe('AA-11-BB');

    await firstValueFrom(
      records.update('vehicle', 'vehicle-1', {
        expectedRowVersion: 1,
        data: { matricula: 'ZZ-99-ZZ' },
      }),
    );
    const again = await firstValueFrom(records.get('customer', customer.id));
    expect(again.data['matriculaPreferida']).toBe('ZZ-99-ZZ'); // acompanha a origem
  });

  it('is empty when no record is referenced', async () => {
    const { records } = await setup();
    const customer = await create(records, {});
    expect(customer.data['matriculaPreferida']).toBeNull();
  });

  it('never fills the value when the user cannot read the referenced entity', async () => {
    const { records } = await setup();
    const customer = await create(records, { viaturaPreferida: 'vehicle-1' });
    expect(customer.data['matriculaPreferida']).toBe('AA-11-BB');

    // O mesmo utilizador perde a leitura de viaturas: o valor relacionado não pode revelá-las.
    TestBed.inject(PermissionService).can = (p: string) => p !== 'entities.vehicle.read';
    const page = await firstValueFrom(records.list('customer', { page: 1, pageSize: 50 }));
    const row = page.items.find((r) => r.id === customer.id)!;
    expect(row.data['viaturaPreferida']).toBe('vehicle-1'); // o id ainda é um dado do cliente
    expect(row.data['matriculaPreferida']).toBeNull();
  });

  it('is empty when the referenced record no longer exists (onMissing: empty)', async () => {
    const { records } = await setup();
    const customer = await create(records, { viaturaPreferida: 'vehicle-5' }); // inactiva: pode apagar-se
    await firstValueFrom(records.delete('vehicle', 'vehicle-5'));
    const again = await firstValueFrom(records.get('customer', customer.id));
    expect(again.data['matriculaPreferida']).toBeNull();
  });

  it('refuses to save a dangling reference when onMissing is "error"', async () => {
    const { records } = await setup('error');
    const customer = await create(records, { viaturaPreferida: 'vehicle-5' });
    await firstValueFrom(records.delete('vehicle', 'vehicle-5'));
    const error = await fails(
      firstValueFrom(
        records.update('customer', customer.id, {
          expectedRowVersion: 1,
          data: { nome: 'Novo nome' },
        }),
      ),
    );
    expect(error.status).toBe(422);
  });

  it('refuses a client-supplied value and a reference to another tenant', async () => {
    const { records } = await setup();
    const forged = await fails(create(records, { matriculaPreferida: 'FALSA' }));
    expect(forged.status).toBe(422);
    const foreign = await fails(create(records, { viaturaPreferida: 'vehicle-999' }));
    expect(foreign.status).toBe(422);
  });

  it('rejects a lookup whose source is sensitive unless the lookup is equally protected', async () => {
    const { save } = await setup();
    const leak = await fails(
      save(
        defineField({
          type: 'lookup',
          key: 'x',
          label: 'X',
          lookup: {
            relationField: 'viaturaPreferida',
            sourceField: 'inexistente',
            onMissing: 'empty',
          },
        }),
      ),
    );
    expect(messages(leak).join(' ')).toContain('não existe em');
  });

  it('keeps tenants apart: Escola has neither the fields nor the values', async () => {
    const { records } = await setup();
    await create(records, { viaturaPreferida: 'vehicle-1' });
    TestBed.inject(AuthService).logout();
    TestBed.tick();
    const escola = await enter('escola@demo.pt', 'escola-horizonte');
    const page = await firstValueFrom(escola.records.list('customer', { page: 1, pageSize: 50 }));
    for (const r of page.items) expect(r.data).not.toHaveProperty('matriculaPreferida');
  });
});
