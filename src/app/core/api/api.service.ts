import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { APP_ENVIRONMENT } from '../config/app-environment';
import type { PageRequest } from './pagination.model';

type QueryParams = Record<string, string | number | boolean>;

/** Envelope de sucesso da API: `{ data, meta: { correlationId } }`. */
interface Envelope<T> {
  readonly data: T;
}

export interface RequestOptions {
  /** Cabeçalhos extra (ex.: o selector de tenant de um tenant ainda não activo). */
  readonly headers?: Record<string, string>;
  readonly params?: QueryParams;
}

/**
 * Cliente HTTP base. Os adapters HTTP de cada domínio dependem deste serviço e não de `HttpClient`.
 * Os caminhos são relativos a `apiUrl`; as respostas de sucesso vêm no envelope da API e este serviço
 * entrega só o `data` (as respostas 204 entregam `undefined`).
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(APP_ENVIRONMENT).apiUrl;

  get<T>(path: string, options?: RequestOptions): Observable<T> {
    return this.http
      .get<Envelope<T> | null>(this.url(path), this.init(options))
      .pipe(map(unwrap<T>));
  }

  /** Listagem paginada. O formato dos parâmetros é provisório até existir contrato do backend. */
  list<T>(path: string, request: PageRequest): Observable<T> {
    return this.get<T>(path, { params: pageRequestToParams(request) });
  }

  post<T>(path: string, body: unknown, options?: RequestOptions): Observable<T> {
    return this.http
      .post<Envelope<T> | null>(this.url(path), body, this.init(options))
      .pipe(map(unwrap<T>));
  }

  put<T>(path: string, body: unknown, options?: RequestOptions): Observable<T> {
    return this.http
      .put<Envelope<T> | null>(this.url(path), body, this.init(options))
      .pipe(map(unwrap<T>));
  }

  patch<T>(path: string, body: unknown, options?: RequestOptions): Observable<T> {
    return this.http
      .patch<Envelope<T> | null>(this.url(path), body, this.init(options))
      .pipe(map(unwrap<T>));
  }

  delete<T>(path: string, options?: RequestOptions): Observable<T> {
    return this.http
      .delete<Envelope<T> | null>(this.url(path), this.init(options))
      .pipe(map(unwrap<T>));
  }

  private url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private init(options?: RequestOptions) {
    return {
      headers: options?.headers,
      params: options?.params ? new HttpParams({ fromObject: options.params }) : undefined,
    };
  }
}

function unwrap<T>(body: Envelope<T> | null): T {
  return (body === null ? undefined : body.data) as T;
}

export function pageRequestToParams(request: PageRequest): QueryParams {
  const params: QueryParams = { page: request.page, pageSize: request.pageSize };
  if (request.sort) {
    params['sort'] = `${request.sort.key}:${request.sort.direction}`;
  }
  return { ...params, ...request.filters };
}
