import { TestBed } from '@angular/core/testing';
import { firstValueFrom, type Observable } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import { EntityRecordsGateway } from '../dynamic/data-access/entity-records.gateway';
import type { RecordQuery } from '../dynamic/models/entity-record.model';
import type { RecordValidationFailure } from '../dynamic/models/validation-issue.model';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';

const Q: RecordQuery = { page: 1, pageSize: 8 };

async function enter(email: string, slug: string): Promise<EntityRecordsGateway> {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  return TestBed.inject(EntityRecordsGateway);
}

const call = <T>(observable: Observable<T>): Promise<T> => firstValueFrom(observable);
const fails = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('Era esperado um erro e a operação foi bem-sucedida.');
};
const issuesOf = (error: ApiError) => (error.details as RecordValidationFailure).issues;

const validVehicle = { matricula: 'ZZ-00-ZZ', marca: 'Volvo', quilometragem: 10 };

describe('mock backend de registos: listagem', () => {
  beforeEach(() => setupMockBackend());

  it('paginates and counts', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const page1 = await call(api.list('vehicle', Q));
    expect(page1).toMatchObject({ total: 12, page: 1, pageSize: 8 });
    expect(page1.items).toHaveLength(8);
    expect((await call(api.list('vehicle', { ...Q, page: 2 }))).items).toHaveLength(4);
  });

  it('searches by matrícula and brand, ignoring case and accents', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const search = async (text: string) =>
      (await call(api.list('vehicle', { ...Q, search: text }))).items.map(
        (r) => r.data['matricula'],
      );
    expect(await search('volvo')).toEqual(['AA-11-BB', 'OO-88-PP']);
    expect(await search('aa-11')).toEqual(['AA-11-BB']);
    expect(await search('MERCÉDES')).toEqual(['GG-44-HH', 'WW-20-XX']);
    expect(await search('FH')).toEqual([]); // modelo não é pesquisável
  });

  it('filters by fuel and by status, and combines filters', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const total = async (filters: Record<string, string>) =>
      (await call(api.list('vehicle', { ...Q, filters }))).total;
    expect(await total({ combustivel: 'eletrico' })).toBe(1);
    expect(await total({ status: 'inactive' })).toBe(2);
    expect(await total({ combustivel: 'gasoleo', status: 'maintenance' })).toBe(2);
    expect(await total({ combustivel: 'eletrico', status: 'maintenance' })).toBe(0);
  });

  it('sorts, with empty values always last', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const sorted = async (key: string, direction: 'asc' | 'desc') =>
      (
        await call(api.list('vehicle', { page: 1, pageSize: 20, sort: { key, direction } }))
      ).items.map((r) => r.data[key]);
    expect((await sorted('quilometragem', 'desc'))[0]).toBe(210000);
    expect((await sorted('modelo', 'asc')).at(-1) ?? null).toBeNull(); // WW-20-XX não tem modelo
    expect((await sorted('modelo', 'desc')).at(-1) ?? null).toBeNull();
    expect((await sorted('combustivel', 'asc'))[0]).toBe('eletrico'); // ordena pelo rótulo "Eléctrico"
  });
});

describe('mock backend: isolamento por tenant', () => {
  beforeEach(() => setupMockBackend());

  it('each tenant only sees its own records of the same global entity', async () => {
    const atlas = await enter('frota@demo.pt', 'transportes-atlas');
    expect((await call(atlas.list('note', Q))).items.map((r) => r.data['titulo'])).toEqual([
      'Renovar seguro da frota',
      'Agendar inspecção periódica',
    ]);
    TestBed.resetTestingModule();
    setupMockBackend();
    const escola = await enter('escola@demo.pt', 'escola-horizonte');
    expect((await call(escola.list('note', Q))).total).toBe(3);
  });

  it('a record of another tenant is indistinguishable from one that does not exist', async () => {
    const atlas = await enter('frota@demo.pt', 'transportes-atlas');
    await expect(call(atlas.get('note', 'note-3'))).rejects.toMatchObject({ status: 404 }); // pertence à Escola
    await expect(call(atlas.get('note', 'note-999'))).rejects.toMatchObject({ status: 404 });
    await expect(
      call(atlas.update('note', 'note-3', { data: { titulo: 'x' }, expectedRowVersion: 1 })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(call(atlas.delete('note', 'note-3'))).rejects.toMatchObject({ status: 404 });
    await expect(call(atlas.audit('note', 'note-3'))).rejects.toMatchObject({ status: 404 });
  });

  it('entities of another tenant do not exist for this one', async () => {
    const escola = await enter('escola@demo.pt', 'escola-horizonte');
    expect((await fails(call(escola.list('vehicle', Q)))).status).toBe(404);
  });

  it('a tenant without the module has no entities at all, even for an admin', async () => {
    const clinica = await enter('multi@demo.pt', 'clinica-vida');
    expect((await fails(call(clinica.list('note', Q)))).status).toBe(404);
  });
});

describe('mock backend: permissões (RBAC + ABAC)', () => {
  beforeEach(() => setupMockBackend());

  it('an operator may read, create and update vehicles but not delete or create drivers', async () => {
    const api = await enter('operador@demo.pt', 'transportes-atlas');
    expect((await call(api.list('vehicle', Q))).total).toBe(12);
    const created = await call(api.create('vehicle', { data: validVehicle }));
    expect(created.id).toMatch(/^vehicle-/);
    await call(
      api.update('vehicle', created.id, { data: { marca: 'Scania' }, expectedRowVersion: 1 }),
    );
    expect((await fails(call(api.delete('vehicle', 'vehicle-5')))).status).toBe(403);
    expect((await fails(call(api.create('driver', { data: { nome: 'x' } })))).status).toBe(403);
  });

  it('a role without entity permissions is refused by the server (UI bypass does not help)', async () => {
    const api = await enter('multi@demo.pt', 'escola-horizonte'); // Secretário
    expect((await fails(call(api.list('note', Q)))).status).toBe(403);
    expect((await fails(call(api.create('note', { data: { titulo: 'x' } })))).status).toBe(403);
  });

  it('applies the ABAC policy on the server: only inactive vehicles can be deleted', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const denied = await fails(call(api.delete('vehicle', 'vehicle-1'))); // disponível
    expect(denied).toMatchObject({
      status: 403,
      message: 'Só é possível eliminar viaturas inactivas.',
    });

    await call(api.delete('vehicle', 'vehicle-5')); // inactiva
    await expect(call(api.get('vehicle', 'vehicle-5'))).rejects.toMatchObject({ status: 404 });
    expect((await call(api.list('vehicle', Q))).total).toBe(11);
  });
});

describe('mock backend: validação de servidor (422)', () => {
  beforeEach(() => setupMockBackend());

  it('re-validates required fields even if the client skipped validation', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const error = await fails(call(api.create('vehicle', { data: { quilometragem: 0 } })));
    expect(error.status).toBe(422);
    expect(issuesOf(error).map((i) => [i.fieldKey, i.rule])).toEqual([
      ['matricula', 'required'],
      ['marca', 'required'],
    ]);
  });

  it('enforces uniqueness per tenant, ignoring case and spaces', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const error = await fails(
      call(api.create('vehicle', { data: { ...validVehicle, matricula: ' aa-11-bb ' } })),
    );
    expect(issuesOf(error)).toEqual([
      {
        fieldKey: 'matricula',
        rule: 'unique',
        message: 'Já existe uma viatura com esta matrícula.',
      },
    ]);
  });

  it('rejects negative mileage, unknown fields, invalid options and unknown references', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const error = await fails(
      call(
        api.create('vehicle', {
          data: { ...validVehicle, quilometragem: -1, combustivel: 'vapor', segredo: 'x' },
        }),
      ),
    );
    expect(
      issuesOf(error)
        .map((i) => `${i.fieldKey}:${i.rule}`)
        .sort(),
    ).toEqual(['combustivel:type', 'quilometragem:min', 'segredo:server']);

    const driver = { nome: 'Rui', numeroCarta: 'L-9', categoria: 'B', validadeCarta: '2030-01-01' };
    expect(
      issuesOf(
        await fails(call(api.create('driver', { data: { ...driver, viatura: 'vehicle-999' } }))),
      ),
    ).toEqual([{ fieldKey: 'viatura', rule: 'server', message: 'A referência não existe.' }]);
    await call(api.create('driver', { data: { ...driver, viatura: 'vehicle-1' } }));
  });

  it('enforces conditional rules on the server', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const heavy = { nome: 'Rui', numeroCarta: 'L-9', categoria: 'C', validadeCarta: '2030-01-01' };
    expect(issuesOf(await fails(call(api.create('driver', { data: heavy }))))[0]).toMatchObject({
      fieldKey: 'numeroCap',
      rule: 'required',
    });
    await call(api.create('driver', { data: { ...heavy, numeroCap: 'CAP-1' } }));
  });

  it('creates with the initial status, current definition version and an audit trail', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const created = await call(
      api.create('vehicle', { data: { ...validVehicle, combustivel: 'gasoleo' } }),
    );
    expect(created).toMatchObject({
      status: 'available',
      definitionVersion: 2,
      rowVersion: 1,
      tenantId: 't-atlas',
    });
    expect((await call(api.list('vehicle', Q))).total).toBe(13);

    const [entry] = await call(api.audit('vehicle', created.id));
    expect(entry).toMatchObject({ action: 'create', actorName: 'Paulo Frota' });
    expect(entry?.changes.map((c) => c.field).sort()).toEqual([
      'combustivel',
      'marca',
      'matricula',
      'quilometragem',
    ]);
  });
});

describe('mock backend: actualização, concorrência e transições', () => {
  beforeEach(() => setupMockBackend());

  it('updates, bumps rowVersion and audits only what changed', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const updated = await call(
      api.update('vehicle', 'vehicle-1', {
        data: { quilometragem: 13000, marca: 'Volvo' },
        expectedRowVersion: 1,
      }),
    );
    expect(updated.rowVersion).toBe(2);
    expect(updated.data['quilometragem']).toBe(13000);

    const [latest] = await call(api.audit('vehicle', 'vehicle-1'));
    expect(latest).toMatchObject({
      action: 'update',
      changes: [{ field: 'quilometragem', from: 12500, to: 13000 }],
    });
  });

  it('a no-op update changes nothing (no version bump, no audit entry)', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const before = await call(api.audit('vehicle', 'vehicle-1'));
    const same = await call(
      api.update('vehicle', 'vehicle-1', { data: { marca: 'Volvo' }, expectedRowVersion: 1 }),
    );
    expect(same.rowVersion).toBe(1);
    expect(await call(api.audit('vehicle', 'vehicle-1'))).toHaveLength(before.length);
  });

  it('rejects a stale write (optimistic concurrency)', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    await call(
      api.update('vehicle', 'vehicle-1', { data: { quilometragem: 1 }, expectedRowVersion: 1 }),
    );
    const error = await fails(
      call(
        api.update('vehicle', 'vehicle-1', { data: { quilometragem: 2 }, expectedRowVersion: 1 }),
      ),
    );
    expect(error.status).toBe(409);
  });

  it('uniqueness excludes the record itself', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    await call(
      api.update('vehicle', 'vehicle-1', {
        data: { matricula: 'AA-11-BB', marca: 'Volvo FH' },
        expectedRowVersion: 1,
      }),
    );
    const clash = await fails(
      call(
        api.update('vehicle', 'vehicle-1', {
          data: { matricula: 'CC-22-DD' },
          expectedRowVersion: 2,
        }),
      ),
    );
    expect(issuesOf(clash)[0]).toMatchObject({ fieldKey: 'matricula', rule: 'unique' });
  });

  it('keeps old records valid after the definition gained a field (v1 → v2)', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    const legacy = await call(api.get('vehicle', 'vehicle-2')); // criada na v1: sem numeroChassis
    expect(legacy).toMatchObject({ definitionVersion: 1 });
    expect('numeroChassis' in legacy.data).toBe(false);
    const updated = await call(
      api.update('vehicle', 'vehicle-2', {
        data: { numeroChassis: 'YS2R4X20005399401' },
        expectedRowVersion: 1,
      }),
    );
    expect(updated.definitionVersion).toBe(2);
  });

  it('runs workflow transitions and audits them', async () => {
    const api = await enter('operador@demo.pt', 'transportes-atlas');
    const moved = await call(api.transition('vehicle', 'vehicle-1', 'send-to-maintenance'));
    expect(moved.status).toBe('maintenance');
    const [entry] = await call(api.audit('vehicle', 'vehicle-1'));
    expect(entry).toMatchObject({
      action: 'transition',
      actorName: 'Sofia Operadora',
      changes: [{ field: 'status', from: 'available', to: 'maintenance' }],
    });
  });

  it('enforces approval and workflow rules on the server', async () => {
    const operator = await enter('operador@demo.pt', 'transportes-atlas');
    expect(
      await fails(call(operator.transition('vehicle', 'vehicle-1', 'deactivate'))),
    ).toMatchObject({ status: 403, message: 'Esta transição exige aprovação.' });
    expect(
      (await fails(call(operator.transition('vehicle', 'vehicle-2', 'deactivate')))).status,
    ).toBe(422); // não existe a partir de "Em manutenção"
  });

  it('lets an approver deactivate and then allows deleting', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    expect((await call(api.transition('vehicle', 'vehicle-1', 'deactivate'))).status).toBe(
      'inactive',
    );
    await call(api.delete('vehicle', 'vehicle-1'));
  });

  it('lists the audit trail newest first', async () => {
    const api = await enter('frota@demo.pt', 'transportes-atlas');
    await call(api.transition('vehicle', 'vehicle-1', 'send-to-maintenance'));
    expect((await call(api.audit('vehicle', 'vehicle-1'))).map((e) => e.action)).toEqual([
      'transition',
      'create',
    ]);
  });
});

describe('mock backend: lookup de referências', () => {
  beforeEach(() => setupMockBackend());

  it('returns labels, filtered by search or by ids', async () => {
    const api = await enter('operador@demo.pt', 'transportes-atlas');
    expect((await call(api.lookup('vehicle', {}))).length).toBe(12);
    expect(await call(api.lookup('vehicle', { search: 'cc-22' }))).toEqual([
      { id: 'vehicle-2', label: 'CC-22-DD' },
    ]);
    expect(await call(api.lookup('vehicle', { ids: ['vehicle-1', 'vehicle-6'] }))).toEqual([
      { id: 'vehicle-1', label: 'AA-11-BB' },
      { id: 'vehicle-6', label: 'KK-66-LL' },
    ]);
  });

  it('requires read access to the target entity', async () => {
    const api = await enter('multi@demo.pt', 'escola-horizonte');
    expect((await fails(call(api.lookup('note', {})))).status).toBe(403);
  });
});
