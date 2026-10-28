import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import { AuthService } from '../auth/auth.service';
import { APP_ENVIRONMENT } from '../config/app-environment';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../testing/test-backend';
import { authInterceptor } from './auth.interceptor';
import { errorInterceptor } from './error.interceptor';
import { tenantScopeInterceptor } from './tenant-scope.interceptor';

const API = 'http://api.test/api/v1';

describe('HTTP interceptors', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    setupMockBackend();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: APP_ENVIRONMENT,
          useValue: {
            production: false,
            name: 'test',
            appName: 'T',
            apiUrl: API,
            defaultLocale: 'pt-PT',
            defaultCurrency: 'EUR',
            defaultTimeZone: 'UTC',
          },
        },
        provideHttpClient(
          withInterceptors([authInterceptor, tenantScopeInterceptor, errorInterceptor]),
        ),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  describe('credentials, CSRF and tenant selector', () => {
    beforeEach(async () => {
      await loginAs('multi@demo.pt');
      await firstValueFrom(TestBed.inject(TenantContextService).activate('escola-horizonte'));
    });

    it('sends the session cookie and the tenant selector to our API, never an Authorization token', () => {
      http.get(`${API}/things`).subscribe();
      const own = controller.expectOne(`${API}/things`);
      expect(own.request.withCredentials).toBe(true);
      expect(own.request.headers.get('X-Tenant-Id')).toBe('t-escola');
      expect(own.request.headers.has('Authorization')).toBe(false);
      own.flush({});
    });

    it('adds the CSRF token to writes only', () => {
      http.get(`${API}/things`).subscribe();
      expect(controller.expectOne(`${API}/things`).request.headers.has('X-Csrf-Token')).toBe(false);

      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        http.request(method, `${API}/things`, { body: {} }).subscribe();
        const req = controller.expectOne(`${API}/things`);
        expect(req.request.headers.get('X-Csrf-Token')).toBe('mock-csrf-u-multi');
        req.flush({});
      }
    });

    it('does not touch requests to other hosts', () => {
      http.get('https://third.party/x').subscribe();
      const other = controller.expectOne('https://third.party/x');
      expect(other.request.withCredentials).toBe(false);
      expect(other.request.headers.has('X-Tenant-Id')).toBe(false);
      expect(other.request.headers.has('X-Csrf-Token')).toBe(false);
      other.flush({});
    });

    it('does not send a tenant selector on tenant-free endpoints', () => {
      for (const path of [
        '/auth/login',
        '/auth/logout',
        '/me/tenants',
        '/me/sessions',
        '/me/password',
        '/me/security-events',
        '/invitations/accept',
      ]) {
        http.post(`${API}${path}`, {}).subscribe();
        const req = controller.expectOne(`${API}${path}`);
        expect(req.request.headers.has('X-Tenant-Id'), path).toBe(false);
        req.flush({});
      }
    });

    it('keeps an explicit selector set by the caller', () => {
      http.get(`${API}/context`, { headers: { 'X-Tenant-Id': 'explicit' } }).subscribe();
      const req = controller.expectOne(`${API}/context`);
      expect(req.request.headers.get('X-Tenant-Id')).toBe('explicit');
      req.flush({});
    });
  });

  describe('tenant switch', () => {
    it('cancels the in-flight requests of the previous tenant', async () => {
      await loginAs('multi@demo.pt');
      const tenants = TestBed.inject(TenantContextService);
      await firstValueFrom(tenants.activate('escola-horizonte'));

      const received: unknown[] = [];
      let completed = false;
      http
        .get(`${API}/slow`)
        .subscribe({ next: (v) => received.push(v), complete: () => (completed = true) });
      const slow = controller.expectOne(`${API}/slow`);

      await firstValueFrom(tenants.activate('clinica-vida'));

      expect(slow.cancelled).toBe(true);
      expect(completed).toBe(true);
      expect(received).toEqual([]);
    });

    it('does not cancel requests of the new tenant', async () => {
      await loginAs('multi@demo.pt');
      const tenants = TestBed.inject(TenantContextService);
      await firstValueFrom(tenants.activate('escola-horizonte'));
      await firstValueFrom(tenants.activate('clinica-vida'));

      const received: unknown[] = [];
      http.get(`${API}/fresh`).subscribe((v) => received.push(v));
      const req = controller.expectOne(`${API}/fresh`);
      expect(req.request.headers.get('X-Tenant-Id')).toBe('t-clinica');
      req.flush({ ok: true });
      expect(received).toEqual([{ ok: true }]);
    });

    it('cancels tenant requests on logout', async () => {
      await loginAs('multi@demo.pt');
      const tenants = TestBed.inject(TenantContextService);
      await firstValueFrom(tenants.activate('escola-horizonte'));
      http.get(`${API}/slow`).subscribe();
      const slow = controller.expectOne(`${API}/slow`);

      TestBed.inject(AuthService).logout();
      TestBed.tick();

      expect(slow.cancelled).toBe(true);
    });
  });

  describe('errors', () => {
    it('normalises the API error envelope (code, message, field errors, correlation id)', () => {
      let error: ApiError | undefined;
      http.post(`${API}/x`, {}).subscribe({ error: (e: ApiError) => (error = e) });
      controller.expectOne(`${API}/x`).flush(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Verifique os campos indicados.',
            details: [{ path: 'email', code: 'INVALID_EMAIL', message: 'O email não é válido.' }],
            correlationId: 'corr-1',
          },
        },
        { status: 422, statusText: 'Unprocessable' },
      );
      expect(error).toMatchObject({
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'Verifique os campos indicados.',
        correlationId: 'corr-1',
        fieldErrors: [{ path: 'email', code: 'INVALID_EMAIL', message: 'O email não é válido.' }],
      });
    });

    it('exposes Retry-After on rate limits', () => {
      let error: ApiError | undefined;
      http.post(`${API}/auth/login`, {}).subscribe({ error: (e: ApiError) => (error = e) });
      controller
        .expectOne(`${API}/auth/login`)
        .flush(
          { error: { code: 'RATE_LIMITED', message: 'Demasiadas tentativas.' } },
          { status: 429, statusText: 'Too Many', headers: { 'Retry-After': '120' } },
        );
      expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 120 });
    });

    it('survives bodies that are not the API envelope', () => {
      let error: ApiError | undefined;
      http.get(`${API}/x`).subscribe({ error: (e: ApiError) => (error = e) });
      controller.expectOne(`${API}/x`).flush('<html>', { status: 502, statusText: 'Bad Gateway' });
      expect(error).toMatchObject({ status: 502, message: 'Bad Gateway' });
    });

    it('maps network failures to status 0', () => {
      let error: ApiError | undefined;
      http.get(`${API}/x`).subscribe({ error: (e: ApiError) => (error = e) });
      controller.expectOne(`${API}/x`).error(new ProgressEvent('error'));
      expect(error?.status).toBe(0);
    });
  });

  describe('401', () => {
    it('ends the local session and redirects to login, without calling the server again', async () => {
      await loginAs('multi@demo.pt');
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      http.get(`${API}/x`).subscribe({ error: () => undefined });
      controller.expectOne(`${API}/x`).flush({}, { status: 401, statusText: 'Unauthorized' });

      expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
      expect(navigate).toHaveBeenCalledWith(['/auth/login'], expect.anything());
      controller.expectNone(`${API}/auth/logout`);
    });

    it('does not treat wrong credentials as an expired session', async () => {
      await loginAs('multi@demo.pt');
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      http.post(`${API}/auth/login`, {}).subscribe({ error: () => undefined });
      controller
        .expectOne(`${API}/auth/login`)
        .flush({ error: { code: 'INVALID_CREDENTIALS' } }, { status: 401, statusText: 'x' });

      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
