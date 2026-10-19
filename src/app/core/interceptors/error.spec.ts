import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ApiError } from '../../models/api-error.model';
import { errorInterceptor } from './error';

describe('errorInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  function failWith(body: object, init: { status: number; statusText: string }): ApiError {
    let result: ApiError | undefined;
    http.get('/x').subscribe({ error: (e: ApiError) => (result = e) });
    controller.expectOne('/x').flush(body, init);
    return result as ApiError;
  }

  it('maps server errors using the response message', () => {
    const error = failWith({ message: 'Inválido' }, { status: 400, statusText: 'Bad Request' });
    expect(error.status).toBe(400);
    expect(error.message).toBe('Inválido');
  });

  it('maps network failures to status 0', () => {
    let result: ApiError | undefined;
    http.get('/x').subscribe({ error: (e: ApiError) => (result = e) });
    controller.expectOne('/x').error(new ProgressEvent('error'));
    expect(result?.status).toBe(0);
  });
});
