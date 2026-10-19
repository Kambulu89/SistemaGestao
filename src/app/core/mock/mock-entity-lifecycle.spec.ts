import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import type { DefinitionFailure } from '../dynamic/data-access/custom-field.gateway';
import type { SaveEntityDraftInput } from '../dynamic/data-access/entity-definition.gateway';
import { AuthService } from '../auth/auth.service';
import { CustomFieldRegistryService } from '../dynamic/custom-field-registry.service';
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

describe('Entidades do tenant: publicar exige permissão própria', () => {
  beforeEach(() => {
    setupMockBackend();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PermissionService,
          useValue: { can: (p: string) => p !== 'configuration.forms.publish' },
        },
      ],
    });
  });

  it('saves drafts but refuses to publish (403)', async () => {
    const { registry } = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(registry.saveDraft(EQUIPAMENTO));
    const error = await fails(firstValueFrom(registry.publish('equipamento')));
    expect(error.status).toBe(403);
    expect(registry.find('equipamento')).toBeUndefined();
  });
});

describe('Numeração automática (servidor)', () => {
  beforeEach(() => setupMockBackend());

  const auto = (reset: 'never' | 'yearly' | 'monthly' = 'never') =>
    defineField({
      type: 'auto-number',
      key: 'numero',
      label: 'Número',
      searchable: true,
      autoNumber: { prefix: 'EQ-', padding: 4, start: 1, reset },
    });
  const entity = (reset?: 'never' | 'yearly' | 'monthly'): SaveEntityDraftInput => ({
    ...EQUIPAMENTO,
    fields: [auto(reset), ...EQUIPAMENTO.fields],
  });
  const create = (records: EntityRecordsGateway, codigo: string) =>
    firstValueFrom(records.create('equipamento', { data: { codigo, designacao: codigo } }));

  async function publish(reset?: 'never' | 'yearly' | 'monthly') {
    const ctx = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(ctx.registry.saveDraft(entity(reset)));
    await firstValueFrom(ctx.registry.publish('equipamento'));
    return ctx;
  }

  it('assigns consecutive numbers on the server, starting at the configured value', async () => {
    const { records } = await publish();
    const a = await create(records, 'A');
    const b = await create(records, 'B');
    expect([a.data['numero'], b.data['numero']]).toEqual(['EQ-0001', 'EQ-0002']);
  });

  it('never reuses a number, even after the record is deleted', async () => {
    const { records } = await publish();
    const a = await create(records, 'A');
    await firstValueFrom(records.delete('equipamento', a.id));
    const b = await create(records, 'B');
    expect(b.data['numero']).toBe('EQ-0002');
  });

  it('refuses a client-supplied number and refuses to change it', async () => {
    const { records } = await publish();
    const forged = await fails(
      firstValueFrom(
        records.create('equipamento', {
          data: { codigo: 'X', designacao: 'X', numero: 'EQ-9999' },
        }),
      ),
    );
    expect(forged.status).toBe(422);
    const a = await create(records, 'A');
    const edit = await fails(
      firstValueFrom(
        records.update('equipamento', a.id, { expectedRowVersion: 1, data: { numero: 'EQ-0000' } }),
      ),
    );
    expect(edit.status).toBe(422);
    const ok = await firstValueFrom(
      records.update('equipamento', a.id, { expectedRowVersion: 1, data: { designacao: 'novo' } }),
    );
    expect(ok.data['numero']).toBe('EQ-0001'); // o número mantém-se
  });

  it('puts the period into the number and keeps one sequence per period', async () => {
    const { records } = await publish('yearly');
    const year = String(new Date().getUTCFullYear());
    const a = await create(records, 'A');
    expect(a.data['numero']).toBe(`EQ-${year}-0001`);
  });

  it('keeps sequences independent per tenant', async () => {
    const atlas = await publish();
    await create(atlas.records, 'A');
    await create(atlas.records, 'B');
    // O tenant Atlas já tem o campo `numeroCliente` (CLI-) semeado: continua depois dos dados existentes.
    const customer = await firstValueFrom(
      atlas.records.create('customer', { data: { nome: 'Novo cliente' } }),
    );
    expect(customer.data['numeroCliente']).toBe('CLI-0004');
  });
});

describe('Fórmulas (servidor)', () => {
  beforeEach(() => setupMockBackend());

  const PEDIDO: SaveEntityDraftInput = {
    key: 'pedido',
    names: { singular: 'Pedido', plural: 'Pedidos' },
    icon: 'cube',
    expectedVersion: null,
    fields: [
      defineField({ type: 'text', key: 'ref', label: 'Referência', required: true }),
      defineField({ type: 'number', key: 'quantidade', label: 'Quantidade' }),
      defineField({ type: 'currency', key: 'preco', label: 'Preço', currency: 'EUR', scale: 2 }),
      defineField({
        type: 'currency',
        key: 'desconto',
        label: 'Desconto',
        currency: 'EUR',
        scale: 2,
      }),
      defineField({
        type: 'formula',
        key: 'subtotal',
        label: 'Subtotal',
        formula: { source: 'quantidade * preco - desconto' },
        scale: 2,
        sortable: true,
      }),
      defineField({
        type: 'formula',
        key: 'total',
        label: 'Total com IVA',
        formula: { source: 'round(subtotal * 1.23, 2)' },
        scale: 2,
      }),
    ],
  };

  async function publish() {
    const ctx = await enter('frota@demo.pt', 'transportes-atlas');
    await firstValueFrom(ctx.registry.saveDraft(PEDIDO));
    await firstValueFrom(ctx.registry.publish('pedido'));
    return ctx;
  }
  const create = (r: EntityRecordsGateway, data: Record<string, unknown>) =>
    firstValueFrom(r.create('pedido', { data: { ref: 'P', ...data } as never }));

  it('computes chained formulas on the server, exactly', async () => {
    const { records } = await publish();
    const pedido = await create(records, { quantidade: 3, preco: 19.99, desconto: 0.07 });
    expect(pedido.data['subtotal']).toBe(59.9);
    expect(pedido.data['total']).toBe(73.68);
  });

  it('recalculates on update and leaves the result empty when an input is missing', async () => {
    const { records } = await publish();
    const pedido = await create(records, { quantidade: 2, preco: 10, desconto: 0 });
    expect(pedido.data['subtotal']).toBe(20);
    const updated = await firstValueFrom(
      records.update('pedido', pedido.id, { expectedRowVersion: 1, data: { quantidade: 5 } }),
    );
    expect(updated.data['subtotal']).toBe(50);
    const partial = await create(records, { quantidade: 2, preco: 10 });
    expect(partial.data['subtotal']).toBeNull(); // falta o desconto: nunca se assume zero
  });

  it('refuses a client-supplied formula result', async () => {
    const { records } = await publish();
    const forged = await fails(
      firstValueFrom(records.create('pedido', { data: { ref: 'X', subtotal: 1 } })),
    );
    expect(forged.status).toBe(422);
  });

  it('keeps the audit trail of computed values', async () => {
    const { records } = await publish();
    const pedido = await create(records, { quantidade: 1, preco: 5, desconto: 1 });
    const audit = await firstValueFrom(records.audit('pedido', pedido.id));
    expect(audit[0]!.changes.find((c) => c.field === 'subtotal')).toMatchObject({ to: 4 });
  });

  it('sorts by a formula field', async () => {
    const { records } = await publish();
    await create(records, { ref: 'A', quantidade: 1, preco: 30, desconto: 0 });
    await create(records, { ref: 'B', quantidade: 1, preco: 10, desconto: 0 });
    const page = await firstValueFrom(
      records.list('pedido', { ...Q, sort: { key: 'subtotal', direction: 'asc' } }),
    );
    expect(page.items.map((r) => r.data['ref'])).toEqual(['B', 'A']);
  });

  it('refuses to publish a circular formula, even if the draft was saved', async () => {
    const { registry } = await enter('frota@demo.pt', 'transportes-atlas');
    const circular = defineField({
      type: 'formula',
      key: 'a',
      label: 'A',
      formula: { source: 'b' },
      scale: 0,
    });
    const other = defineField({
      type: 'formula',
      key: 'b',
      label: 'B',
      formula: { source: 'a' },
      scale: 0,
    });
    await firstValueFrom(
      registry.saveDraft({ ...PEDIDO, key: 'ciclo', fields: [circular, other] }),
    );
    const error = await fails(firstValueFrom(registry.publish('ciclo')));
    expect(error.status).toBe(422);
    expect(messages(error).join(' ')).toContain('Dependência circular');
  });
});

describe('Fórmulas e dados sensíveis', () => {
  beforeEach(() => setupMockBackend());

  async function adminAddsFields() {
    const admin = await enter('escola@demo.pt', 'escola-horizonte');
    const custom = TestBed.inject(CustomFieldRegistryService);
    const sensitive = {
      sensitivity: 'sensitive' as const,
      permissions: {
        read: 'entities.customer.sensitive.read',
        write: 'entities.customer.sensitive.write',
      },
    };
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
    return { admin, save, sensitive };
  }

  it('blocks a formula that would leak a sensitive field into a visible one', async () => {
    const { save, sensitive } = await adminAddsFields();
    await save(
      defineField({
        type: 'currency',
        key: 'valorContrato',
        label: 'Valor do contrato',
        currency: 'EUR',
        ...sensitive,
      }),
    );
    const leak = await fails(
      save(
        defineField({
          type: 'formula',
          key: 'valorAnual',
          label: 'Valor anual',
          formula: { source: 'valorContrato * 12' },
          scale: 2,
        }),
      ),
    );
    expect(leak.status).toBe(422);
    expect(messages(leak).join(' ')).toContain('campo sensível "valorContrato"');
  });

  it('hides the result of a sensitive formula from users without the permission', async () => {
    const { admin, save, sensitive } = await adminAddsFields();
    await save(
      defineField({
        type: 'currency',
        key: 'valorContrato',
        label: 'Valor do contrato',
        currency: 'EUR',
        ...sensitive,
      }),
    );
    await save(
      defineField({
        type: 'formula',
        key: 'valorAnual',
        label: 'Valor anual',
        formula: { source: 'valorContrato * 12' },
        scale: 2,
        ...sensitive,
      }),
    );
    const created = await firstValueFrom(
      admin.records.create('customer', { data: { nome: 'Cliente VIP', valorContrato: 100.5 } }),
    );
    expect(created.data['valorAnual']).toBe(1206);

    const secretary = await switchTo('multi@demo.pt', 'escola-horizonte');
    const custom = TestBed.inject(CustomFieldRegistryService);
    custom.reload();
    await firstValueFrom(secretary.registry.ensureLoaded());
    const page = await firstValueFrom(
      secretary.records.list('customer', { page: 1, pageSize: 50 }),
    );
    const vip = page.items.find((r) => r.data['nome'] === 'Cliente VIP')!;
    expect(vip.data).not.toHaveProperty('valorContrato');
    expect(vip.data).not.toHaveProperty('valorAnual');
    const denied = await fails(
      firstValueFrom(
        secretary.records.list('customer', { ...Q, sort: { key: 'valorAnual', direction: 'asc' } }),
      ),
    );
    expect(denied.status).toBe(403);
  });
});
