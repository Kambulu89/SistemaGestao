import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { APP_ENVIRONMENT } from '../config/app-environment';
import { ApiService } from './api.service';

describe('ApiService', () => {
  it('builds list requests from a PageRequest relative to apiUrl', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: APP_ENVIRONMENT, useValue: { apiUrl: 'http://api.test/api' } },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    TestBed.inject(ApiService)
      .list('/things', {
        page: 2,
        pageSize: 10,
        sort: { key: 'name', direction: 'asc' },
        filters: { status: 'active' },
      })
      .subscribe();

    const req = TestBed.inject(HttpTestingController).expectOne(
      (r) => r.url === 'http://api.test/api/things',
    );
    expect(req.request.params.get('page')).toBe('2');
    expect(req.request.params.get('pageSize')).toBe('10');
    expect(req.request.params.get('sort')).toBe('name:asc');
    expect(req.request.params.get('status')).toBe('active');
  });
});
