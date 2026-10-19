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

const API = 'http://api.test/api';

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
        provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('attaches token and tenant only to our API', async () => {
    await loginAs('multi@demo.pt');
    await firstValueFrom(TestBed.inject(TenantContextService).activate('escola-horizonte'));

    http.get(`${API}/things`).subscribe();
    const own = controller.expectOne(`${API}/things`);
    expect(own.request.headers.get('Authorization')).toBe('Bearer mock-token-u-multi');
    expect(own.request.headers.get('X-Tenant-Id')).toBe('t-escola');
    own.flush({});

    http.get('https://third.party/x').subscribe();
    const other = controller.expectOne('https://third.party/x');
    expect(other.request.headers.has('Authorization')).toBe(false);
    other.flush({});
  });

  it('normalises server errors to ApiError', () => {
    let error: ApiError | undefined;
    http.get(`${API}/x`).subscribe({ error: (e: ApiError) => (error = e) });
    controller
      .expectOne(`${API}/x`)
      .flush({ message: 'Inválido' }, { status: 400, statusText: 'Bad Request' });
    expect(error).toMatchObject({ status: 400, message: 'Inválido' });
  });

  it('maps network failures to status 0', () => {
    let error: ApiError | undefined;
    http.get(`${API}/x`).subscribe({ error: (e: ApiError) => (error = e) });
    controller.expectOne(`${API}/x`).error(new ProgressEvent('error'));
    expect(error?.status).toBe(0);
  });

  it('ends the session and redirects to login on 401', async () => {
    await loginAs('multi@demo.pt');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    http.get(`${API}/x`).subscribe({ error: () => undefined });
    controller.expectOne(`${API}/x`).flush({}, { status: 401, statusText: 'Unauthorized' });

    expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/auth/login'], expect.anything());
  });
});
