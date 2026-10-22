import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { APP_ENVIRONMENT } from '../config/app-environment';
import { HttpAuthGateway } from './http-auth.gateway';

const API = 'http://api.test/api/v1';
const envelope = (data: unknown) => ({ data, meta: { correlationId: 'c-1' } });

describe('HttpAuthGateway', () => {
  let gateway: HttpAuthGateway;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: APP_ENVIRONMENT, useValue: { apiUrl: API } },
        provideHttpClient(),
        provideHttpClientTesting(),
        HttpAuthGateway,
      ],
    });
    gateway = TestBed.inject(HttpAuthGateway);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('logs in and maps the API user (no token: the session is an HttpOnly cookie)', async () => {
    const promise = firstValueFrom(gateway.login({ email: 'ana@exemplo.pt', password: 'p' }));
    const req = http.expectOne(`${API}/auth/login`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'ana@exemplo.pt', password: 'p' });
    req.flush(
      envelope({
        user: { id: 'u1', email: 'ana@exemplo.pt', displayName: 'Ana Silva', locale: null },
        csrfToken: 'csrf',
        expiresAt: '2026-10-23T00:00:00.000Z',
      }),
    );
    http.expectOne(`${API}/platform/me`).flush(envelope({ permissions: [] }));
    expect(await promise).toEqual({
      user: { id: 'u1', name: 'Ana Silva', email: 'ana@exemplo.pt', platformPermissions: [] },
      csrfToken: 'csrf',
      expiresAt: '2026-10-23T00:00:00.000Z',
    });
  });

  it('restores the session from GET /me', async () => {
    const promise = firstValueFrom(gateway.restore());
    http.expectOne(`${API}/me`).flush(
      envelope({
        user: { id: 'u1', email: 'a@b.pt', displayName: 'A' },
        csrfToken: 'csrf',
        session: { id: 's', expiresAt: '2026-10-23T00:00:00.000Z' },
      }),
    );
    http.expectOne(`${API}/platform/me`).flush(envelope({ permissions: [] }));
    const session = await promise;
    expect(session?.csrfToken).toBe('csrf');
    expect(session?.user.platformPermissions).toEqual([]);
  });

  it('translates the platform grants of the account (and nothing else) into UI permissions', async () => {
    const promise = firstValueFrom(gateway.restore());
    http.expectOne(`${API}/me`).flush(
      envelope({
        user: { id: 'u1', email: 'root@b.pt', displayName: 'Root' },
        csrfToken: 'csrf',
        session: { id: 's', expiresAt: '2026-10-23T00:00:00.000Z' },
      }),
    );
    http
      .expectOne(`${API}/platform/me`)
      .flush(envelope({ permissions: ['platform.billing.manage'] }));
    const permissions = (await promise)?.user.platformPermissions ?? [];
    expect(permissions).toEqual(
      expect.arrayContaining([
        'platform.access',
        'platform.billing.manage',
        'platform.plans.read',
        'platform.subscriptions.read',
      ]),
    );
    // Só a concessão pedida: nada de gerir tenants nem de configurações de plataforma.
    expect(permissions).not.toContain('platform.tenant.manage');
    expect(permissions).not.toContain('platform.tenants.read');
  });

  it('treats a failing platform/me as "not a platform admin" without breaking the session', async () => {
    const promise = firstValueFrom(gateway.restore());
    http.expectOne(`${API}/me`).flush(
      envelope({
        user: { id: 'u1', email: 'a@b.pt', displayName: 'A' },
        csrfToken: 'csrf',
        session: { id: 's', expiresAt: '2026-10-23T00:00:00.000Z' },
      }),
    );
    http.expectOne(`${API}/platform/me`).flush({}, { status: 500, statusText: 'x' });
    expect((await promise)?.user.platformPermissions).toEqual([]);
  });

  it('treats a 401 on restore as "no session"', async () => {
    const promise = firstValueFrom(gateway.restore());
    http
      .expectOne(`${API}/me`)
      .flush({ error: { code: 'UNAUTHENTICATED' } }, { status: 401, statusText: 'x' });
    expect(await promise).toBeNull();
  });

  it('does not hide other failures on restore', async () => {
    const promise = firstValueFrom(gateway.restore());
    http.expectOne(`${API}/me`).flush({}, { status: 500, statusText: 'x' });
    await expect(promise).rejects.toBeTruthy();
  });

  it('posts logout, forgot-password and reset-password to the API', async () => {
    const logout = firstValueFrom(gateway.logout());
    http.expectOne(`${API}/auth/logout`).flush(null, { status: 204, statusText: 'No Content' });
    await logout;

    const forgot = firstValueFrom(gateway.requestPasswordReset('a@b.pt'));
    const f = http.expectOne(`${API}/auth/forgot-password`);
    expect(f.request.body).toEqual({ email: 'a@b.pt' });
    f.flush(envelope({ message: 'ok' }), { status: 202, statusText: 'Accepted' });
    expect(await forgot).toBeUndefined();

    const reset = firstValueFrom(gateway.resetPassword('tok', 'nova-senha-longa'));
    const r = http.expectOne(`${API}/auth/reset-password`);
    expect(r.request.body).toEqual({ token: 'tok', newPassword: 'nova-senha-longa' });
    r.flush(null, { status: 204, statusText: 'No Content' });
    await reset;
  });
});
