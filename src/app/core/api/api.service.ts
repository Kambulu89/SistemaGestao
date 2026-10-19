import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { APP_ENVIRONMENT } from '../config/app-environment';
import type { PageRequest } from './pagination.model';

type QueryParams = Record<string, string | number | boolean>;

/**
 * Cliente HTTP base. Os adapters HTTP de cada domínio (futuros) devem depender
 * deste serviço e não de `HttpClient`. Os caminhos são relativos a `apiUrl`.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(APP_ENVIRONMENT).apiUrl;

  get<T>(path: string, params?: QueryParams): Observable<T> {
    return this.http.get<T>(this.url(path), { params: this.toParams(params) });
  }

  /** Listagem paginada. O formato dos parâmetros é provisório até existir contrato do backend. */
  list<T>(path: string, request: PageRequest): Observable<T> {
    return this.get<T>(path, pageRequestToParams(request));
  }

  post<T>(path: string, body: unknown): Observable<T> {
    return this.http.post<T>(this.url(path), body);
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(this.url(path), body);
  }

  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http.patch<T>(this.url(path), body);
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path));
  }

  private url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private toParams(params?: QueryParams): HttpParams | undefined {
    return params ? new HttpParams({ fromObject: params }) : undefined;
  }
}

export function pageRequestToParams(request: PageRequest): QueryParams {
  const params: QueryParams = { page: request.page, pageSize: request.pageSize };
  if (request.sort) {
    params['sort'] = `${request.sort.key}:${request.sort.direction}`;
  }
  return { ...params, ...request.filters };
}
