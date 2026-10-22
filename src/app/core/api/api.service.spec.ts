import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { APP_ENVIRONMENT } from '../config/app-environment';
import { ApiService } from './api.service';

describe('ApiService', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: APP_ENVIRONMENT, useValue: { apiUrl: 'http://api.test/api' } },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('builds list requests from a PageRequest relative to apiUrl', () => {
    api
      .list('/things', {
        page: 2,
        pageSize: 10,
        sort: { key: 'name', direction: 'asc' },
        filters: { status: 'active' },
      })
      .subscribe();

    const req = http.expectOne((r) => r.url === 'http://api.test/api/things');
    expect(req.request.params.get('page')).toBe('2');
    expect(req.request.params.get('pageSize')).toBe('10');
    expect(req.request.params.get('sort')).toBe('name:asc');
    expect(req.request.params.get('status')).toBe('active');
  });

  it('delivers only `data` from the success envelope', async () => {
    const promise = firstValueFrom(api.get<{ id: string }>('things/1'));
    http
      .expectOne('http://api.test/api/things/1')
      .flush({ data: { id: '1' }, meta: { correlationId: 'c' } });
    expect(await promise).toEqual({ id: '1' });
  });

  it('delivers undefined for 204 responses', async () => {
    const promise = firstValueFrom(api.delete<void>('things/1'));
    http
      .expectOne('http://api.test/api/things/1')
      .flush(null, { status: 204, statusText: 'No Content' });
    expect(await promise).toBeUndefined();
  });

  it('forwards extra headers and query parameters', () => {
    api.get('things', { headers: { 'X-Tenant-Id': 't' }, params: { q: 'ab' } }).subscribe();
    const req = http.expectOne((r) => r.url === 'http://api.test/api/things');
    expect(req.request.headers.get('X-Tenant-Id')).toBe('t');
    expect(req.request.params.get('q')).toBe('ab');
  });
});
