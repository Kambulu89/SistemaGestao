import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface ErrorDetail {
  path: string;
  code: string;
  message: string;
}

/** Erro devolvido pela API (`{ error: { code, message, details, requestId } }`) ou falha de rede. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetail[] = [],
    readonly requestId: string | null = null,
  ) {
    super(message);
  }

  /** Mensagem do campo indicado (validação do servidor), se existir. */
  field(path: string): string | null {
    return this.details.find((d) => d.path === path)?.message ?? null;
  }

  static from(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof HttpErrorResponse) {
      const body = error.error?.error;
      if (body?.code)
        return new ApiError(
          error.status,
          body.code,
          body.message,
          body.details ?? [],
          body.requestId ?? null,
        );
      if (error.status === 0)
        return new ApiError(0, 'NETWORK', 'Sem ligação ao servidor. Verifique a rede.');
      return new ApiError(
        error.status,
        'HTTP_ERROR',
        'O servidor respondeu com um erro inesperado.',
      );
    }
    return new ApiError(0, 'UNKNOWN', 'Ocorreu um erro inesperado.');
  }
}

export interface Page<T> {
  items: T[];
  total: number;
}

type Query = Record<string, string | number | boolean | null | undefined>;

const params = (query: Query = {}) => {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
  return p;
};

/**
 * Cliente da API `/api/v1`: devolve `data` (ou página com `meta.total`) e converte erros em `ApiError`. O cookie de sessão,
 * o CSRF (`X-XSRF-TOKEN`) e o `X-Tenant-Id` são tratados pelos interceptores.
 */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  private async call<T>(request: Promise<{ data: T; meta?: Record<string, unknown> }>) {
    try {
      return await request;
    } catch (error) {
      throw ApiError.from(error);
    }
  }

  async get<T>(url: string, query?: Query): Promise<T> {
    return (
      await this.call(
        firstValueFrom(this.http.get<{ data: T }>(`/api/v1/${url}`, { params: params(query) })),
      )
    ).data;
  }

  async page<T>(url: string, query?: Query): Promise<Page<T>> {
    const body = await this.call(
      firstValueFrom(
        this.http.get<{ data: T[]; meta: { total: number } }>(`/api/v1/${url}`, {
          params: params(query),
        }),
      ),
    );
    return { items: body.data, total: Number(body.meta?.['total'] ?? body.data.length) };
  }

  async getWithMeta<T>(
    url: string,
    query?: Query,
  ): Promise<{ data: T; meta: Record<string, unknown> }> {
    const body = await this.call(
      firstValueFrom(
        this.http.get<{ data: T; meta: Record<string, unknown> }>(`/api/v1/${url}`, {
          params: params(query),
        }),
      ),
    );
    return { data: body.data, meta: body.meta ?? {} };
  }

  async post<T>(url: string, body: unknown = {}): Promise<T> {
    return (await this.call(firstValueFrom(this.http.post<{ data: T }>(`/api/v1/${url}`, body))))
      .data;
  }

  async patch<T>(url: string, body: unknown): Promise<T> {
    return (await this.call(firstValueFrom(this.http.patch<{ data: T }>(`/api/v1/${url}`, body))))
      .data;
  }

  async put<T>(url: string, body: unknown): Promise<T> {
    return (await this.call(firstValueFrom(this.http.put<{ data: T }>(`/api/v1/${url}`, body))))
      .data;
  }

  async delete(url: string): Promise<void> {
    await this.call(firstValueFrom(this.http.delete<{ data: never }>(`/api/v1/${url}`)));
  }

  /** Descarga binária (anexos): devolve o conteúdo e o nome indicado pelo servidor. */
  async download(url: string): Promise<{ blob: Blob; fileName: string | null }> {
    try {
      const response = await firstValueFrom(
        this.http.get(`/api/v1/${url}`, { observe: 'response', responseType: 'blob' }),
      );
      const disposition = response.headers.get('content-disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
      return { blob: response.body!, fileName: encoded ? decodeURIComponent(encoded) : null };
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.error instanceof Blob) {
        const text = await error.error.text();
        throw ApiError.from(
          new HttpErrorResponse({
            error: safeJson(text),
            status: error.status,
            statusText: error.statusText,
          }),
        );
      }
      throw ApiError.from(error);
    }
  }

  async upload<T>(url: string, form: FormData): Promise<T> {
    return (await this.call(firstValueFrom(this.http.post<{ data: T }>(`/api/v1/${url}`, form))))
      .data;
  }
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
