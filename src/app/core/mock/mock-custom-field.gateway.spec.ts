import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import { CustomFieldRegistryService } from '../dynamic/custom-field-registry.service';
import {
  CustomFieldGateway,
  type DefinitionFailure,
  type SaveCustomFieldInput,
} from '../dynamic/data-access/custom-field.gateway';
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
  return { registry, api: TestBed.inject(CustomFieldGateway) };
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

const input = (
  field: Parameters<typeof defineField>[0],
  overrides: Partial<SaveCustomFieldInput> = {},
): SaveCustomFieldInput => ({
  id: null,
  entity: { kind: 'core', key: 'customer' },
  field: defineField(field),
  showInList: false,
  state: 'active',
  expectedVersion: null,
  ...overrides,
});

describe('Mock backend: gestão de campos personalizados', () => {
  beforeEach(() => setupMockBackend());

  it('publishes a new field and merges it into the entity for that tenant only', async () => {
    const { registry, api } = await enter('escola@demo.pt', 'escola-horizonte');
    const saved = await firstValueFrom(
      api.save(input({ type: 'text', key: 'proximoContacto', label: 'Próximo contacto' })),
    );
    expect(saved).toMatchObject({ version: 1, state: 'active', tenantId: 't-escola' });
    expect(saved.field.origin).toBe('custom');

    TestBed.inject(CustomFieldRegistryService).reload();
    await firstValueFrom(registry.ensureLoaded());
    expect(registry.find('customer')!.fields.map((f) => f.key)).toContain('proximoContacto');
  });

  it('keeps a draft out of the entity until it is published', async () => {
    const { registry, api } = await enter('escola@demo.pt', 'escola-horizonte');
    const custom = TestBed.inject(CustomFieldRegistryService);
    await firstValueFrom(
      custom.save(input({ type: 'text', key: 'rascunho', label: 'Rascunho' }, { state: 'draft' })),
    );
    expect(registry.find('customer')!.fields.map((f) => f.key)).not.toContain('rascunho');

    const draft = custom.all().find((c) => c.field.key === 'rascunho')!;
    await firstValueFrom(
      custom.save(
        input(draft.field, { id: draft.id, expectedVersion: draft.version, state: 'active' }),
      ),
    );
    expect(registry.find('customer')!.fields.map((f) => f.key)).toContain('rascunho');
    expect(api).toBeDefined();
  });

  it('refuses users without the manage permission (403)', async () => {
    const { api } = await enter('multi@demo.pt', 'escola-horizonte'); // Secretário
    const error = await fails(
      firstValueFrom(api.save(input({ type: 'text', key: 'novo', label: 'Novo' }))),
    );
    expect(error.status).toBe(403);
  });

  it('rejects duplicate codes, including archived ones, and native collisions', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const dup = await fails(
      firstValueFrom(api.save(input({ type: 'text', key: 'faxAntigo', label: 'Fax' }))),
    );
    expect(dup.status).toBe(422);
    expect(messages(dup).join(' ')).toContain('já existe');
    const native = await fails(
      firstValueFrom(api.save(input({ type: 'text', key: 'email', label: 'Email 2' }))),
    );
    expect(messages(native).join(' ')).toContain('colide com um campo nativo');
  });

  it('rejects an invalid code, an empty name and types not yet available', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const code = await fails(
      firstValueFrom(api.save(input({ type: 'text', key: 'Código Inválido', label: 'X' }))),
    );
    expect(messages(code).join(' ')).toContain('camelCase');
    const preview = await fails(
      firstValueFrom(
        api.save(
          input({
            type: 'lookup',
            key: 'numero',
            label: 'Nº',
            lookup: { relationField: 'nome', sourceField: 'nome', onMissing: 'empty' },
          }),
        ),
      ),
    );
    expect(messages(preview).join(' ')).toContain('ainda não está disponível');
  });

  it('forbids changing the type or removing options of a published field', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const custom = TestBed.inject(CustomFieldRegistryService);
    await firstValueFrom(custom.ensureLoaded());
    const sector = custom.all().find((c) => c.field.key === 'sectorActividade')!;

    const retype = await fails(
      firstValueFrom(
        api.save(
          input(
            { type: 'text', key: 'sectorActividade', label: 'Sector' },
            { id: sector.id, expectedVersion: sector.version },
          ),
        ),
      ),
    );
    expect(retype.status).toBe(422);

    const options = sector.field.type === 'select' ? sector.field.options : [];
    const removed = await fails(
      firstValueFrom(
        api.save(
          input(
            { type: 'select', key: 'sectorActividade', label: 'Sector', options: options.slice(1) },
            { id: sector.id, expectedVersion: sector.version },
          ),
        ),
      ),
    );
    expect(removed.status).toBe(422);

    const deactivated = await firstValueFrom(
      api.save(
        input(
          {
            type: 'select',
            key: 'sectorActividade',
            label: 'Sector',
            options: options.map((o, i) => (i === 0 ? { ...o, active: false } : o)),
          },
          { id: sector.id, expectedVersion: sector.version },
        ),
      ),
    );
    expect(deactivated.version).toBe(sector.version + 1);
  });

  it('detects concurrent edits (409)', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const custom = TestBed.inject(CustomFieldRegistryService);
    await firstValueFrom(custom.ensureLoaded());
    const field = custom.all().find((c) => c.field.key === 'dataRenovacao')!;
    const error = await fails(
      firstValueFrom(api.save(input(field.field, { id: field.id, expectedVersion: 99 }))),
    );
    expect(error.status).toBe(409);
  });

  it('archives a field: it leaves the entity but the registry keeps it', async () => {
    const { registry } = await enter('escola@demo.pt', 'escola-horizonte');
    const custom = TestBed.inject(CustomFieldRegistryService);
    const field = custom.all().find((c) => c.field.key === 'dataRenovacao')!;
    const archived = await firstValueFrom(custom.setState(field.id, 'archived'));
    expect(archived.state).toBe('archived');
    expect(registry.find('customer')!.fields.map((f) => f.key)).not.toContain('dataRenovacao');
    const back = await firstValueFrom(custom.setState(field.id, 'active'));
    expect(back.state).toBe('active');
    expect(registry.find('customer')!.fields.map((f) => f.key)).toContain('dataRenovacao');
  });

  it("never lets a tenant change another tenant's field (404)", async () => {
    const { api } = await enter('frota@demo.pt', 'transportes-atlas');
    const error = await fails(
      firstValueFrom(api.setState('cf-t-escola-sectorActividade', 'archived')),
    );
    expect(error.status).toBe(404);
    const save = await fails(
      firstValueFrom(
        api.save(
          input(
            { type: 'text', key: 'sectorActividade', label: 'X' },
            { id: 'cf-t-escola-sectorActividade', expectedVersion: 1 },
          ),
        ),
      ),
    );
    expect(save.status).toBe(404);
  });

  it('refuses to add fields to a non-extensible entity', async () => {
    const { api } = await enter('frota@demo.pt', 'transportes-atlas');
    const error = await fails(
      firstValueFrom(
        api.save(
          input(
            { type: 'text', key: 'extra', label: 'Extra' },
            { entity: { kind: 'core', key: 'note' } },
          ),
        ),
      ),
    );
    expect(messages(error).join(' ')).toContain('não aceita campos personalizados');
  });
});

describe('Mock backend: publicar exige permissão própria', () => {
  beforeEach(() => {
    setupMockBackend();
    // Um papel que gere rascunhos mas não publica.
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PermissionService,
          useValue: { can: (p: string) => p !== 'configuration.forms.publish' },
        },
      ],
    });
  });

  it('lets the role save drafts but refuses to publish or archive (403)', async () => {
    const { api } = await enter('escola@demo.pt', 'escola-horizonte');
    const draft = await firstValueFrom(
      api.save(
        input({ type: 'text', key: 'soRascunho', label: 'Só rascunho' }, { state: 'draft' }),
      ),
    );
    expect(draft.state).toBe('draft');

    const publish = await fails(
      firstValueFrom(api.save(input({ type: 'text', key: 'publicado', label: 'Publicado' }))),
    );
    expect(publish.status).toBe(403);
    const archive = await fails(
      firstValueFrom(api.setState('cf-t-escola-dataRenovacao', 'archived')),
    );
    expect(archive.status).toBe(403);
  });
});
