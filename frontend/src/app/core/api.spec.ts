import { HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Api, ApiError } from './api';
import { apiInterceptor } from './http';
import { Session } from './session';
import { Workspace } from './workspace';

describe('ApiError.from', () => {
  it('lê o envelope de erro da API', () => {
    const e = ApiError.from(
      new HttpErrorResponse({
        status: 422,
        error: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Verifique',
            details: [{ path: 'name', code: 'X', message: 'Curto' }],
            requestId: 'r1',
          },
        },
      }),
    );
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.field('name')).toBe('Curto');
    expect(e.requestId).toBe('r1');
  });

  it('distingue falha de rede', () => {
    expect(ApiError.from(new HttpErrorResponse({ status: 0 })).code).toBe('NETWORK');
  });
});

describe('Api com interceptor', () => {
  let http: HttpTestingController;
  let api: Api;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(Api);
  });

  it('envia a empresa seleccionada em X-Tenant-Id e devolve data', async () => {
    TestBed.inject(Workspace).tenantId.set('11111111-1111-4111-8111-111111111111');
    const promise = api.get<{ ok: boolean }>('context');
    const req = http.expectOne('/api/v1/context');
    expect(req.request.headers.get('X-Tenant-Id')).toBe('11111111-1111-4111-8111-111111111111');
    req.flush({ data: { ok: true }, meta: { requestId: 'r' } });
    expect(await promise).toEqual({ ok: true });
  });

  it('página: lê meta.total', async () => {
    const promise = api.page('members', { limit: 10, q: '' });
    const req = http.expectOne((r) => r.url === '/api/v1/members');
    expect(req.request.params.get('limit')).toBe('10');
    expect(req.request.params.has('q')).toBe(false);
    req.flush({ data: [{ id: 1 }], meta: { total: 42 } });
    expect(await promise).toEqual({ items: [{ id: 1 }], total: 42 });
  });

  it('sessão expirada (401) limpa a sessão e vai para o login', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const session = TestBed.inject(Session);
    session.user.set({
      id: 'u',
      email: 'a@b',
      fullName: 'A',
      isPlatformAdmin: false,
      lastLoginAt: null,
    });
    const promise = api.get('members');
    http
      .expectOne('/api/v1/members')
      .flush(
        { error: { code: 'UNAUTHENTICATED', message: 'Sessão expirada', details: [] } },
        { status: 401, statusText: 'Unauthorized' },
      );
    await expect(promise).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(session.user()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/entrar'], expect.anything());
  });
});
