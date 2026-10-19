import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import type { DefinitionFailure } from '../dynamic/data-access/custom-field.gateway';
import type { SaveEntityDraftInput } from '../dynamic/data-access/entity-definition.gateway';
import { AuthService } from '../auth/auth.service';
import { EntityRecordsGateway } from '../dynamic/data-access/entity-records.gateway';
import { defineField } from '../dynamic/engine/define-entity';
import { DynamicEntityRegistryService } from '../dynamic/entity-registry.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';

async function enter(email: string, slug: string) {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  const registry = TestBed.inject(DynamicEntityRegistryService);
  await firstValueFrom(registry.ensureLoaded());
  return { registry, records: TestBed.inject(EntityRecordsGateway) };
}

async function switchTo(email: string, slug: string) {
  TestBed.inject(AuthService).logout();
  TestBed.tick();
  return enter(email, slug);
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

/** Caso D: Equipamento definido só por metadados, sem qualquer componente específico. */
const EQUIPAMENTO: SaveEntityDraftInput = {
  key: 'equipamento',
  names: { singular: 'Equipamento', plural: 'Equipamentos' },
  description: 'Equipamentos da empresa.',
  icon: 'cube',
  expectedVersion: null,
  fields: [
    defineField({
      type: 'text',
      key: 'codigo',
      label: 'Código',
      required: true,
      searchable: true,
      validations: [{ type: 'unique', message: 'Código já usado.' }],
    }),
    defineField({
      type: 'text',
      key: 'designacao',
      label: 'Designação',
      required: true,
      searchable: true,
    }),
    defineField({ type: 'date', key: 'dataAquisicao', label: 'Data de aquisição' }),
    defineField({
      type: 'currency',
      key: 'valor',
      label: 'Valor',
      currency: 'EUR',
      scale: 2,
      validations: [{ type: 'min', value: 0 }],
    }),
    defineField({ type: 'text', key: 'responsavel', label: 'Responsável' }),
    defineField({
      type: 'select',
      key: 'estado',
      label: 'Estado',
      filterable: true,
      options: [
        { value: 'activo', label: 'Activo' },
        { value: 'avariado', label: 'Avariado' },
      ],
    }),
  ],
};

const Q = { page: 1, pageSize: 20 };

describe('Entidades do tenant: ciclo de vida (caso D)', () => {
  beforeEach(() => setupMockBackend());

  it('keeps a draft out of the registry and the records API until it is published', async () => {
    const { registry, records } = await enter('frota@demo.pt', 'transportes-atlas');
    const draft = await firstValueFrom(registry.saveDraft(EQUIPAMENTO));
    expect(draft).toMatchObject({
      state: 'draft',
      version: 1,
      scope: 'tenant',
      tenantId: 't-atlas',
    });
    expect(registry.find('equipamento')).toBeUndefined();
    expect(registry.draftOf('equipamento')?.id).toBe(draft.id);
    expect((await fails(firstValueFrom(records.list('equipamento', Q)))).status).toBe(404);
  });

  it('publishes and serves forms, list, validation and CRUD from the metadata alone', async () => {
    const { registry, records } = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(registry.saveDraft(EQUIPAMENTO));
    const published = await firstValueFrom(registry.publish('equipamento'));
    expect(published.state).toBe('published');

    const entity = registry.find('equipamento')!;
    expect(entity.permissions.operations.read).toBe('entities.equipamento.read');
    expect(entity.list.columns.map((c) => c.field)).toEqual([
      'codigo',
      'designacao',
      'dataAquisicao',
      'valor',
      'responsavel',
    ]);
    expect(entity.list.searchFields).toEqual(['codigo', 'designacao']);
    expect(entity.list.filters).toEqual(['estado']);

    const created = await firstValueFrom(
      records.create('equipamento', {
        data: { codigo: 'EQ-1', designacao: 'Empilhador', valor: 1500.5, estado: 'activo' },
      }),
    );
    expect(created.entityKey).toBe('equipamento');
    expect(
      (await firstValueFrom(records.list('equipamento', { ...Q, search: 'empil' }))).total,
    ).toBe(1);
    expect(
      (await firstValueFrom(records.list('equipamento', { ...Q, filters: { estado: 'avariado' } })))
        .total,
    ).toBe(0);

    const invalid = await fails(
      firstValueFrom(
        records.create('equipamento', { data: { codigo: 'EQ-1', valor: -1, estado: 'x' } }),
      ),
    );
    expect(invalid.status).toBe(422);
    const fieldsWithIssues = (invalid.details as { issues: { fieldKey: string }[] }).issues.map(
      (i) => i.fieldKey,
    );
    expect(fieldsWithIssues).toEqual(
      expect.arrayContaining(['designacao', 'codigo', 'valor', 'estado']),
    );

    const audit = await firstValueFrom(records.audit('equipamento', created.id));
    expect(audit[0]?.action).toBe('create');
  });

  it('isolates the new entity: other tenants neither see nor reach it', async () => {
    const atlas = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(atlas.registry.saveDraft(EQUIPAMENTO));
    await firstValueFrom(atlas.registry.publish('equipamento'));
    await firstValueFrom(
      atlas.records.create('equipamento', { data: { codigo: 'EQ-9', designacao: 'X' } }),
    );

    const escola = await switchTo('escola@demo.pt', 'escola-horizonte');
    expect(escola.registry.find('equipamento')).toBeUndefined();
    expect((await fails(firstValueFrom(escola.records.list('equipamento', Q)))).status).toBe(404);
  });

  it('requires the manage permission to create, publish or discard', async () => {
    const { registry } = await enter('operador@demo.pt', 'transportes-atlas');
    expect((await fails(firstValueFrom(registry.saveDraft(EQUIPAMENTO)))).status).toBe(403);
    expect((await fails(firstValueFrom(registry.publish('vehicle')))).status).toBe(403);
    expect((await fails(firstValueFrom(registry.discardDraft('vehicle')))).status).toBe(403);
  });

  it('does not grant records access to roles without the new entity permissions', async () => {
    const admin = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(admin.registry.saveDraft(EQUIPAMENTO));
    await firstValueFrom(admin.registry.publish('equipamento'));

    const operator = await switchTo('operador@demo.pt', 'transportes-atlas');
    expect(operator.registry.find('equipamento')).toBeDefined(); // existe no tenant...
    expect((await fails(firstValueFrom(operator.records.list('equipamento', Q)))).status).toBe(403); // ...mas o papel não o lê
  });

  it('rejects invalid keys, platform keys and empty names with a precise message', async () => {
    const { registry } = await enter('frota@demo.pt', 'transportes-atlas');
    const bad = await fails(
      firstValueFrom(registry.saveDraft({ ...EQUIPAMENTO, key: 'Equipamento 1' })),
    );
    expect(messages(bad).join(' ')).toContain('minúsculas, números ou hífens');
    const platform = await fails(
      firstValueFrom(registry.saveDraft({ ...EQUIPAMENTO, key: 'customer' })),
    );
    expect(messages(platform).join(' ')).toContain('pertence a uma entidade da plataforma');
    const names = await fails(
      firstValueFrom(registry.saveDraft({ ...EQUIPAMENTO, names: { singular: '', plural: '' } })),
    );
    expect(messages(names).join(' ')).toContain('singular e no plural');
  });

  it('refuses to publish an entity without fields or with broken fields', async () => {
    const { registry } = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(registry.saveDraft({ ...EQUIPAMENTO, fields: [] }));
    const error = await fails(firstValueFrom(registry.publish('equipamento')));
    expect(error.status).toBe(422);
    expect(registry.find('equipamento')).toBeUndefined();
  });

  it('versions: editing a published entity creates a draft; publishing archives the old version', async () => {
    const { registry } = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(registry.saveDraft(EQUIPAMENTO));
    await firstValueFrom(registry.publish('equipamento'));

    const v2 = await firstValueFrom(
      registry.saveDraft({
        ...EQUIPAMENTO,
        expectedVersion: 1,
        fields: [
          ...EQUIPAMENTO.fields,
          defineField({ type: 'text', key: 'localizacao', label: 'Localização' }),
        ],
      }),
    );
    expect(v2.version).toBe(2);
    expect(registry.find('equipamento')!.version).toBe(1); // a publicada não muda enquanto há rascunho
    expect(registry.find('equipamento')!.fields.map((f) => f.key)).not.toContain('localizacao');

    await firstValueFrom(registry.publish('equipamento'));
    expect(registry.find('equipamento')!.version).toBe(2);
    expect(registry.versionsOf('equipamento').map((d) => [d.version, d.state])).toEqual([
      [2, 'published'],
      [1, 'archived'],
    ]);
  });

  it('blocks a destructive change on publish and lets the draft be discarded', async () => {
    const { registry } = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(registry.saveDraft(EQUIPAMENTO));
    await firstValueFrom(registry.publish('equipamento'));

    const retyped = EQUIPAMENTO.fields.map((f) =>
      f.key === 'valor' ? defineField({ type: 'text', key: 'valor', label: 'Valor' }) : f,
    );
    await firstValueFrom(
      registry.saveDraft({ ...EQUIPAMENTO, expectedVersion: 1, fields: retyped }),
    );
    const error = await fails(firstValueFrom(registry.publish('equipamento')));
    expect(error.status).toBe(422);
    expect(registry.find('equipamento')!.version).toBe(1);

    await firstValueFrom(registry.discardDraft('equipamento'));
    expect(registry.draftOf('equipamento')).toBeUndefined();
    expect(registry.find('equipamento')!.version).toBe(1);
  });

  it('detects stale edits with 409', async () => {
    const { registry } = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(registry.saveDraft(EQUIPAMENTO));
    const stale = await fails(
      firstValueFrom(registry.saveDraft({ ...EQUIPAMENTO, expectedVersion: 7 })),
    );
    expect(stale.status).toBe(409);
  });

  it('a field removed in a new version keeps its stored data (never deleted)', async () => {
    const { registry, records } = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(registry.saveDraft(EQUIPAMENTO));
    await firstValueFrom(registry.publish('equipamento'));
    const created = await firstValueFrom(
      records.create('equipamento', {
        data: { codigo: 'EQ-2', designacao: 'Prensa', responsavel: 'Ana' },
      }),
    );

    // Arquivar o campo (não removê-lo) é a forma segura; os dados continuam gravados.
    const archived = EQUIPAMENTO.fields.map((f) =>
      f.key === 'responsavel' ? { ...f, archived: true } : f,
    );
    await firstValueFrom(
      registry.saveDraft({ ...EQUIPAMENTO, expectedVersion: 1, fields: archived }),
    );
    await firstValueFrom(registry.publish('equipamento'));
    await firstValueFrom(
      records.update('equipamento', created.id, {
        expectedRowVersion: 1,
        data: { designacao: 'Prensa 2' },
      }),
    );
    const store = records as unknown as {
      records: Map<string, { id: string; data: Record<string, unknown> }[]>;
    };
    expect(
      store.records.get('t-atlas:equipamento')!.find((r) => r.id === created.id)!.data[
        'responsavel'
      ],
    ).toBe('Ana');
    expect((await firstValueFrom(records.get('equipamento', created.id))).data).not.toHaveProperty(
      'responsavel',
    );
  });
});
