import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ApiError } from '../../api/api-error.model';
import { AuthService } from '../../auth/auth.service';
import { APP_ENVIRONMENT } from '../../config/app-environment';
import { errorInterceptor } from '../../interceptors/error.interceptor';
import { TenantContextService } from '../../tenant-context/tenant-context.service';
import type { DefinitionFailure } from '../data-access/custom-field.gateway';
import { defineField } from '../engine/define-entity';
import type { EntityDetailDto, EntityDto, FieldDto, VersionDto } from './dynamic-dto';
import { HttpEntityDefinitionGateway } from './http-entity-definition.gateway';

const API = 'http://api.test/api/v1';
const envelope = (data: unknown) => ({ data, meta: { correlationId: 'c-1' } });

const entity = (over: Partial<EntityDto> = {}): EntityDto => ({
  id: 'e1',
  code: 'vehicle',
  name: 'Viatura',
  description: null,
  status: 'PUBLISHED',
  publishedVersion: 1,
  ownershipMode: 'TENANT',
  presentation: { pluralName: 'Viaturas', icon: 'truck' },
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});
const dto = (over: Partial<FieldDto> = {}): FieldDto => ({
  code: 'marca',
  label: 'Marca',
  type: 'TEXT',
  required: false,
  defaultValue: null,
  validation: {},
  options: [],
  position: 0,
  sensitive: false,
  readOnly: false,
  archived: false,
  presentation: {},
  ...over,
});
const version = (revision: number, published: boolean, fields = [dto()]): VersionDto => ({
  id: `v${revision}`,
  revision,
  publishedAt: published ? '2026-01-02T00:00:00Z' : null,
  fields,
});
const detail = (over: Partial<EntityDetailDto> = {}): EntityDetailDto => ({
  entity: entity(),
  published: version(1, true),
  draft: null,
  ...over,
});

const input = (over: Partial<Parameters<HttpEntityDefinitionGateway['saveDraft']>[0]> = {}) => ({
  key: 'vehicle',
  names: { singular: 'Viatura', plural: 'Viaturas' },
  icon: 'truck',
  fields: [defineField({ type: 'text', key: 'marca', label: 'Marca' })],
  expectedVersion: null,
  ...over,
});

describe('HttpEntityDefinitionGateway', () => {
  let gateway: HttpEntityDefinitionGateway;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: APP_ENVIRONMENT, useValue: { apiUrl: API } },
        { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1', slug: 'demo' }) } },
        { provide: AuthService, useValue: { isAuthenticated: () => false } },
        { provide: Router, useValue: {} },
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        HttpEntityDefinitionGateway,
      ],
    });
    gateway = TestBed.inject(HttpEntityDefinitionGateway);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lista as entidades do servidor como definições (publicada e rascunho)', async () => {
    const promise = firstValueFrom(gateway.list());
    http.expectOne(`${API}/entity-definitions`).flush(envelope([entity()]));
    http
      .expectOne(`${API}/entity-definitions/e1`)
      .flush(envelope(detail({ draft: version(2, false) })));
    const list = await promise;
    expect(list.map((d) => [d.key, d.state, d.version])).toEqual([
      ['vehicle', 'published', 1],
      ['vehicle', 'draft', 2],
    ]);
  });

  it('sem entidades não faz mais pedidos; uma entidade não representável não impede as outras', async () => {
    const empty = firstValueFrom(gateway.list());
    http.expectOne(`${API}/entity-definitions`).flush(envelope([]));
    expect(await empty).toEqual([]);

    const promise = firstValueFrom(gateway.list());
    http
      .expectOne(`${API}/entity-definitions`)
      .flush(envelope([entity(), entity({ id: 'e2', code: 'estranha' })]));
    http.expectOne(`${API}/entity-definitions/e1`).flush(envelope(detail()));
    http.expectOne(`${API}/entity-definitions/e2`).flush(
      envelope(
        detail({
          entity: entity({ id: 'e2', code: 'estranha' }),
          published: version(1, true, [dto({ code: 'a__b' })]),
        }),
      ),
    );
    expect((await promise).map((d) => d.key)).toEqual(['vehicle']);
  });

  it('cria uma entidade nova com o primeiro rascunho (códigos snake_case e apresentação)', async () => {
    const promise = firstValueFrom(
      gateway.saveDraft(
        input({
          key: 'ordem-servico',
          names: { singular: 'Ordem', plural: 'Ordens' },
          description: 'Notas',
          fields: [
            defineField({ type: 'text', key: 'dataEntrega', label: 'Entrega', searchable: true }),
          ],
        }),
      ),
    );
    const req = http.expectOne(`${API}/entity-definitions`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toMatchObject({
      code: 'ordem_servico',
      name: 'Ordem',
      description: 'Notas',
      presentation: { pluralName: 'Ordens', icon: 'truck' },
    });
    expect(req.request.body.fields[0]).toMatchObject({ code: 'data_entrega', type: 'TEXT' });
    req.flush(
      envelope(
        detail({
          entity: entity({ code: 'ordem_servico', status: 'DRAFT', publishedVersion: null }),
          published: null,
          draft: version(1, false),
        }),
      ),
    );
    expect(await promise).toMatchObject({ key: 'ordem-servico', state: 'draft' });
  });

  it('guarda o rascunho de uma entidade publicada: abre a revisão, actualiza o nome e substitui os campos', async () => {
    const promise = firstValueFrom(
      gateway.saveDraft(
        input({ expectedVersion: 1, names: { singular: 'Viatura nova', plural: 'Viaturas' } }),
      ),
    );
    http.expectOne(`${API}/entity-definitions`).flush(envelope([entity()]));
    http.expectOne(`${API}/entity-definitions/e1`).flush(envelope(detail()));
    http
      .expectOne(`${API}/entity-definitions/e1/drafts`)
      .flush(envelope(detail({ draft: version(2, false) })));
    const patch = http.expectOne(`${API}/entity-definitions/e1`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toMatchObject({ expectedVersion: 3, name: 'Viatura nova' });
    patch.flush(envelope(detail({ entity: entity({ version: 4 }), draft: version(2, false) })));
    const put = http.expectOne(`${API}/entity-definitions/e1/draft`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body.expectedVersion).toBe(4);
    put.flush(envelope(detail({ entity: entity({ version: 5 }), draft: version(2, false) })));
    expect(await promise).toMatchObject({ state: 'draft', version: 2, rowVersion: 5 });
  });

  it('recusa guardar quando a revisão que a interface viu já não é a actual (409)', async () => {
    const promise = firstValueFrom(gateway.saveDraft(input({ expectedVersion: 1 })));
    http.expectOne(`${API}/entity-definitions`).flush(envelope([entity()]));
    http
      .expectOne(`${API}/entity-definitions/e1`)
      .flush(envelope(detail({ draft: version(2, false) })));
    await expect(promise).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });

  it('não envia nada ao servidor quando um campo não é suportado: devolve os problemas', async () => {
    const promise = firstValueFrom(
      gateway.saveDraft(
        input({
          fields: [
            defineField({ type: 'currency', key: 'valor', label: 'Valor', currency: 'AOA' }),
          ],
        }),
      ),
    );
    await expect(promise).rejects.toMatchObject({ status: 422 });
    http.expectNone(`${API}/entity-definitions`);
    const error = (await promise.catch((e: ApiError) => e)) as ApiError;
    expect((error.details as DefinitionFailure).issues[0]?.path).toBe('fields.valor');
  });

  it('traduz os erros de validação do servidor para o formato do designer (por chave do campo)', async () => {
    const promise = firstValueFrom(
      gateway.saveDraft(
        input({ fields: [defineField({ type: 'text', key: 'marca', label: 'Marca' })] }),
      ),
    );
    http.expectOne(`${API}/entity-definitions`).flush(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Verifique os campos indicados.',
          details: [
            { path: 'fields[0].label', code: 'INVALID_LABEL', message: 'Rótulo inválido.' },
          ],
          correlationId: 'c',
        },
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    const error = (await promise.catch((e: ApiError) => e)) as ApiError;
    expect((error.details as DefinitionFailure).issues).toEqual([
      { severity: 'error', path: 'fields.marca', message: 'Rótulo inválido.' },
    ]);
  });

  it('publica com a versão fresca da entidade e traduz a incompatibilidade (409) em problemas', async () => {
    const ok = firstValueFrom(gateway.publish('vehicle'));
    http.expectOne(`${API}/entity-definitions`).flush(envelope([entity()]));
    http
      .expectOne(`${API}/entity-definitions/e1`)
      .flush(envelope(detail({ draft: version(2, false) })));
    const publish = http.expectOne(`${API}/entity-definitions/e1/publish`);
    expect(publish.request.body).toEqual({ expectedVersion: 3 });
    publish.flush(envelope(detail({ published: version(2, true) })));
    expect(await ok).toMatchObject({ state: 'published', version: 2 });

    const refused = firstValueFrom(gateway.publish('vehicle'));
    http.expectOne(`${API}/entity-definitions`).flush(envelope([entity()]));
    http
      .expectOne(`${API}/entity-definitions/e1`)
      .flush(envelope(detail({ draft: version(2, false) })));
    http.expectOne(`${API}/entity-definitions/e1/publish`).flush(
      {
        error: {
          code: 'INCOMPATIBLE_SCHEMA',
          message: 'Incompatível.',
          details: [
            { path: 'fields.data_compra', code: 'FIELD_TYPE_CHANGED', message: 'O tipo não muda.' },
          ],
          correlationId: 'c',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    const error = (await refused.catch((e: ApiError) => e)) as ApiError;
    expect(error.status).toBe(422);
    expect((error.details as DefinitionFailure).issues[0]).toMatchObject({
      path: 'fields.dataCompra',
      message: 'O tipo não muda.',
    });
  });

  it('descartar: um rascunho de entidade publicada apaga só o rascunho; o primeiro apaga a entidade', async () => {
    const draftOnly = firstValueFrom(gateway.discardDraft('vehicle'));
    http.expectOne(`${API}/entity-definitions`).flush(envelope([entity()]));
    http
      .expectOne(`${API}/entity-definitions/e1`)
      .flush(envelope(detail({ draft: version(2, false) })));
    const draft = http.expectOne(`${API}/entity-definitions/e1/draft`);
    expect(draft.request.method).toBe('DELETE');
    draft.flush(envelope(detail()));
    await draftOnly;

    const first = firstValueFrom(gateway.discardDraft('vehicle'));
    http
      .expectOne(`${API}/entity-definitions`)
      .flush(envelope([entity({ status: 'DRAFT', publishedVersion: null })]));
    http.expectOne(`${API}/entity-definitions/e1`).flush(
      envelope(
        detail({
          entity: entity({ status: 'DRAFT', publishedVersion: null }),
          published: null,
          draft: version(1, false),
        }),
      ),
    );
    const removal = http.expectOne(`${API}/entity-definitions/e1`);
    expect(removal.request.method).toBe('DELETE');
    removal.flush(null, { status: 204, statusText: 'No Content' });
    await first;
  });
});
