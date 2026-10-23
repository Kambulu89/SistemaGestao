import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import type { ApiError } from '../../api/api-error.model';
import { AuthService } from '../../auth/auth.service';
import { APP_ENVIRONMENT } from '../../config/app-environment';
import { errorInterceptor } from '../../interceptors/error.interceptor';
import { TenantContextService } from '../../tenant-context/tenant-context.service';
import { defineEntity } from '../engine/define-entity';
import { DynamicEntityRegistryService } from '../entity-registry.service';
import type { RecordValidationFailure } from '../models/validation-issue.model';
import type { RecordDto } from './dynamic-dto';
import { HttpEntityRecordsGateway } from './http-entity-records.gateway';

const API = 'http://api.test/api/v1';
const envelope = (data: unknown, meta: Record<string, unknown> = {}) => ({
  data,
  meta: { correlationId: 'c-1', ...meta },
});

const vehicle = defineEntity({
  key: 'viatura',
  tenantId: 't1',
  names: { singular: 'Viatura', plural: 'Viaturas' },
  icon: 'truck',
  fields: [
    { type: 'text', key: 'matricula', label: 'Matrícula', sortable: true, searchable: true },
    { type: 'decimal', key: 'precoBase', label: 'Preço', scale: 2, filterable: true },
    { type: 'text', key: 'notaInterna', label: 'Nota', sensitivity: 'sensitive' },
  ],
});

const dto = (over: Partial<RecordDto> = {}): RecordDto => ({
  id: 'r1',
  entityCode: 'viatura',
  schemaVersion: { id: 'v1', revision: 2 },
  data: { matricula: 'AB-12', preco_base: '10.50' },
  archived: false,
  version: 4,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  createdByMembershipId: 'm1',
  updatedByMembershipId: 'm2',
  ...over,
});

describe('HttpEntityRecordsGateway', () => {
  let gateway: HttpEntityRecordsGateway;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: APP_ENVIRONMENT, useValue: { apiUrl: API } },
        { provide: AuthService, useValue: { isAuthenticated: () => false } },
        { provide: Router, useValue: {} },
        { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1', slug: 'demo' }) } },
        {
          provide: DynamicEntityRegistryService,
          useValue: {
            ensureLoaded: () => of([]),
            find: (k: string) => (k === 'viatura' ? vehicle : undefined),
          },
        },
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        HttpEntityRecordsGateway,
      ],
    });
    gateway = TestBed.inject(HttpEntityRecordsGateway);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lista com paginação, pesquisa, ordenação e filtros nos nomes do servidor, e devolve o total', async () => {
    const promise = firstValueFrom(
      gateway.list('viatura', {
        page: 3,
        pageSize: 10,
        search: 'toyota',
        sort: { key: 'precoBase', direction: 'desc' },
        filters: { precoBase: 10.5, status: 'x' },
      }),
    );
    const req = http.expectOne((r) => r.url === `${API}/dynamic/viatura/records`);
    expect(req.request.params.get('limit')).toBe('10');
    expect(req.request.params.get('offset')).toBe('20');
    expect(req.request.params.get('q')).toBe('toyota');
    expect(req.request.params.get('sort')).toBe('preco_base:desc');
    expect(req.request.params.get('filter.preco_base')).toBe('10.5');
    // O estado ainda não existe no servidor.
    expect(req.request.params.keys().some((k) => k.includes('status'))).toBe(false);
    req.flush(envelope([dto()], { total: 31, limit: 10, offset: 20 }));
    const page = await promise;
    expect(page).toMatchObject({ total: 31, page: 3, pageSize: 10 });
    expect(page.items[0]).toMatchObject({
      id: 'r1',
      entityKey: 'viatura',
      tenantId: 't1',
      definitionVersion: 2,
      rowVersion: 4,
      status: null,
      createdBy: 'm1',
      data: { matricula: 'AB-12', precoBase: 10.5 },
    });
  });

  it('ordena por colunas de sistema sem as converter', async () => {
    const promise = firstValueFrom(
      gateway.list('viatura', {
        page: 1,
        pageSize: 5,
        sort: { key: 'updatedAt', direction: 'asc' },
      }),
    );
    const req = http.expectOne((r) => r.url === `${API}/dynamic/viatura/records`);
    expect(req.request.params.get('sort')).toBe('updatedAt:asc');
    req.flush(envelope([]));
    expect((await promise).total).toBe(0);
  });

  it('cria e altera enviando só valores escritáveis, com decimais em texto e a versão lida', async () => {
    const created = firstValueFrom(
      gateway.create('viatura', { data: { matricula: 'AB-12', precoBase: 10.5, vazio: null } }),
    );
    const post = http.expectOne(`${API}/dynamic/viatura/records`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({
      data: { matricula: 'AB-12', preco_base: '10.50', vazio: null },
    });
    post.flush(envelope(dto()));
    expect((await created).id).toBe('r1');

    const updated = firstValueFrom(
      gateway.update('viatura', 'r1', { data: { precoBase: 12 }, expectedRowVersion: 4 }),
    );
    const patch = http.expectOne(`${API}/dynamic/viatura/records/r1`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ data: { preco_base: '12.00' }, expectedVersion: 4 });
    patch.flush(envelope(dto({ version: 5 })));
    expect((await updated).rowVersion).toBe(5);
  });

  it('um valor único repetido (409) chega ao formulário como erro do campo', async () => {
    const promise = firstValueFrom(gateway.create('viatura', { data: { matricula: 'AB-12' } }));
    http.expectOne(`${API}/dynamic/viatura/records`).flush(
      {
        error: {
          code: 'UNIQUE_VALUE_TAKEN',
          message: 'Já existe um registo com este valor.',
          details: [{ path: 'data.matricula', code: 'UNIQUE', message: 'Valor já utilizado.' }],
          correlationId: 'c',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    const error = (await promise.catch((e: ApiError) => e)) as ApiError;
    expect(error.status).toBe(422);
    expect((error.details as RecordValidationFailure).issues).toEqual([
      { fieldKey: 'matricula', rule: 'unique', message: 'Valor já utilizado.' },
    ]);
  });

  it('erros 422 do servidor ficam associados às chaves dos campos (camelCase)', async () => {
    const promise = firstValueFrom(gateway.create('viatura', { data: {} }));
    http.expectOne(`${API}/dynamic/viatura/records`).flush(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Verifique os campos indicados.',
          details: [
            { path: 'data.preco_base', code: 'TOO_SMALL', message: 'Mínimo 0.00.' },
            { path: 'organizationUnitId', code: 'REQUIRED', message: 'Indique a unidade.' },
          ],
          correlationId: 'c',
        },
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    const error = (await promise.catch((e: ApiError) => e)) as ApiError;
    expect((error.details as RecordValidationFailure).issues).toEqual([
      { fieldKey: 'precoBase', rule: 'min', message: 'Mínimo 0.00.' },
      { fieldKey: null, rule: 'required', message: 'Indique a unidade.' },
    ]);
  });

  it('um conflito de versão passa tal como está (a interface sabe mostrá-lo)', async () => {
    const promise = firstValueFrom(
      gateway.update('viatura', 'r1', { data: { matricula: 'X' }, expectedRowVersion: 1 }),
    );
    http.expectOne(`${API}/dynamic/viatura/records/r1`).flush(
      {
        error: { code: 'VERSION_CONFLICT', message: 'Alterado.', details: [], correlationId: 'c' },
      },
      { status: 409, statusText: 'Conflict' },
    );
    expect(((await promise.catch((e: ApiError) => e)) as ApiError).status).toBe(409);
  });

  it('eliminar arquiva com a versão actual (os dados nunca se apagam)', async () => {
    const promise = firstValueFrom(gateway.delete('viatura', 'r1'));
    http.expectOne(`${API}/dynamic/viatura/records/r1`).flush(envelope(dto({ version: 6 })));
    const archive = http.expectOne(`${API}/dynamic/viatura/records/r1/archive`);
    expect(archive.request.body).toEqual({ expectedVersion: 6 });
    archive.flush(envelope(dto({ archived: true })));
    await promise;
  });

  it('as transições de estado não existem no servidor: recusa com 501, sem pedidos', async () => {
    await expect(firstValueFrom(gateway.transition())).rejects.toMatchObject({ status: 501 });
  });

  it('o histórico vem da auditoria: diferenças por campo, sem os valores sensíveis, com o nome de quem alterou', async () => {
    const promise = firstValueFrom(gateway.audit('viatura', 'r1'));
    const logs = http.expectOne((r) => r.url === `${API}/audit-logs`);
    expect(logs.request.params.get('resourceType')).toBe('dynamic_records');
    expect(logs.request.params.get('resourceId')).toBe('r1');
    logs.flush(
      envelope([
        {
          id: 'a2',
          action: 'dynamic_records.UPDATE',
          actorMembershipId: 'm1',
          occurredAt: '2026-01-02T00:00:00Z',
          before: { data: { matricula: 'AB-12', preco_base: '10.50' }, archivedAt: null },
          after: { data: { matricula: 'AB-13', preco_base: '10.50' }, archivedAt: null },
        },
        {
          id: 'a1',
          action: 'dynamic_records.INSERT',
          actorMembershipId: 'm1',
          occurredAt: '2026-01-01T00:00:00Z',
          before: null,
          after: { data: { matricula: 'AB-12' } },
        },
        {
          id: 'a3',
          action: 'dynamic_records.UPDATE',
          actorMembershipId: 'm1',
          occurredAt: '2026-01-03T00:00:00Z',
          before: { data: { matricula: 'AB-13' } },
          after: { data: { matricula: 'AB-13' } },
        },
      ]),
    );
    http
      .expectOne(`${API}/memberships`)
      .flush(envelope([{ id: 'm1', displayName: 'Ana', email: 'a@x.pt', status: 'ACTIVE' }]));
    const entries = await promise;
    // A alteração sem diferenças de dados (só a versão) não aparece; a mais antiga vem primeiro.
    expect(entries.map((e) => [e.action, e.actorName])).toEqual([
      ['create', 'Ana'],
      ['update', 'Ana'],
    ]);
    expect(entries[1]?.changes).toEqual([{ field: 'matricula', from: 'AB-12', to: 'AB-13' }]);
  });

  it('opções de referência: por pesquisa usa a listagem; por ids lê cada registo; utilizadores vêm dos membros', async () => {
    const search = firstValueFrom(gateway.lookup('viatura', { search: 'ab' }));
    const list = http.expectOne((r) => r.url === `${API}/dynamic/viatura/records`);
    expect(list.request.params.get('q')).toBe('ab');
    list.flush(envelope([dto()], { total: 1 }));
    expect(await search).toEqual([{ id: 'r1', label: 'AB-12' }]);

    const byIds = firstValueFrom(gateway.lookup('viatura', { ids: ['r1', 'gone'] }));
    http.expectOne(`${API}/dynamic/viatura/records/r1`).flush(envelope(dto()));
    http
      .expectOne(`${API}/dynamic/viatura/records/gone`)
      .flush(
        { error: { code: 'NOT_FOUND', message: 'x', details: [], correlationId: 'c' } },
        { status: 404, statusText: 'Not Found' },
      );
    expect(await byIds).toEqual([{ id: 'r1', label: 'AB-12' }]);

    const users = firstValueFrom(gateway.lookup('@user', { search: 'an' }));
    http.expectOne(`${API}/memberships`).flush(
      envelope([
        { id: 'm1', displayName: 'Ana', email: null, status: 'ACTIVE' },
        { id: 'm2', displayName: 'Rui', email: null, status: 'ACTIVE' },
        { id: 'm3', displayName: 'Anselmo', email: null, status: 'SUSPENDED' },
      ]),
    );
    expect(await users).toEqual([{ id: 'm1', label: 'Ana' }]);
  });

  it('uma entidade desconhecida da interface dá 404, sem pedir nada ao servidor', async () => {
    await expect(
      firstValueFrom(gateway.list('inexistente', { page: 1, pageSize: 5 })),
    ).rejects.toMatchObject({ status: 404 });
  });
});
