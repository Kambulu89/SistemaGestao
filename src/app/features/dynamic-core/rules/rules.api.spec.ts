import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { APP_ENVIRONMENT } from '../../../core/config/app-environment';
import { RulesApi } from './rules.api';

const API = 'http://api.test/api/v1';

describe('RulesApi', () => {
  let http: HttpTestingController;
  let api: RulesApi;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: APP_ENVIRONMENT, useValue: { apiUrl: API } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(RulesApi);
  });

  afterEach(() => http.verify());

  it('lista por código da entidade e entrega só os dados', async () => {
    const result = firstValueFrom(api.list('ordem_servico'));
    const req = http.expectOne((r) => r.url === `${API}/rules`);
    expect(req.request.params.get('entityCode')).toBe('ordem_servico');
    req.flush({ data: [{ id: 'r1' }], meta: {} });
    expect(await result).toEqual([{ id: 'r1' }]);
  });

  it('cria, altera com expectedVersion, publica, desactiva e abre revisão', async () => {
    const body = {
      name: 'N',
      description: null,
      priority: 100,
      conditionAst: { op: 'true' },
      actionAst: { type: 'BLOCK' as const, message: 'm' },
      effectiveFrom: null,
      effectiveTo: null,
    };
    const calls: [Promise<unknown>, string, string, unknown][] = [
      [
        firstValueFrom(api.create('os', 'r1', body)),
        'POST',
        '/rules',
        { entityCode: 'os', code: 'r1', ...body },
      ],
      [
        firstValueFrom(api.update('x', 4, body)),
        'PATCH',
        '/rules/x',
        { expectedVersion: 4, ...body },
      ],
      [firstValueFrom(api.publish('x', 5)), 'POST', '/rules/x/publish', { expectedVersion: 5 }],
      [firstValueFrom(api.disable('x', 6)), 'POST', '/rules/x/disable', { expectedVersion: 6 }],
      [firstValueFrom(api.createRevision('x')), 'POST', '/rules/x/revisions', {}],
      [
        firstValueFrom(api.simulate('x', { a: 1 })),
        'POST',
        '/rules/x/simulate',
        { values: { a: 1 } },
      ],
    ];
    for (const [promise, method, path, payload] of calls) {
      const req = http.expectOne(`${API}${path}`);
      expect(req.request.method).toBe(method);
      expect(req.request.body).toEqual(payload);
      req.flush({ data: { ok: true }, meta: {} });
      expect(await promise).toEqual({ ok: true });
    }
  });
});
