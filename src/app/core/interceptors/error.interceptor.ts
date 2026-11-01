import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import type { ApiError, ApiErrorDetail } from '../api/api-error.model';
import { AuthService } from '../auth/auth.service';
import { APP_ENVIRONMENT } from '../config/app-environment';

interface ErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
    readonly correlationId?: unknown;
  };
}

const isDetail = (value: unknown): value is ApiErrorDetail =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ApiErrorDetail).path === 'string' &&
  typeof (value as ApiErrorDetail).message === 'string';

/** Converte a resposta de erro da API (`{ error: { code, message, details, correlationId } }`). */
function toApiError(error: HttpErrorResponse): ApiError {
  if (error.status === 0) {
    return { status: 0, message: 'Sem ligação ao servidor. Verifique a sua rede.' };
  }

  const body = (typeof error.error === 'object' && error.error !== null ? error.error : {}) as
    ErrorBody | Record<string, unknown>;
  const envelope = (body as ErrorBody).error;
  const retryAfter = Number(error.headers?.get('Retry-After'));

  return {
    status: error.status,
    message:
      typeof envelope?.message === 'string'
        ? envelope.message
        : error.statusText || 'Ocorreu um erro inesperado.',
    code: typeof envelope?.code === 'string' ? envelope.code : undefined,
    fieldErrors: Array.isArray(envelope?.details) ? envelope.details.filter(isDetail) : undefined,
    details: error.error,
    correlationId: typeof envelope?.correlationId === 'string' ? envelope.correlationId : undefined,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  };
}

/**
 * Normaliza falhas HTTP em `ApiError`. Um 401 num pedido autenticado (que não seja o próprio
 * início de sessão ou o arranque) termina a sessão local e leva ao login.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const apiUrl = inject(APP_ENVIRONMENT).apiUrl;

  return next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) return throwError(() => error);

      const path = req.url.startsWith(apiUrl) ? req.url.slice(apiUrl.length) : req.url;
      const credentialAttempt = path === '/auth/login' || path === '/me';
      if (error.status === 401 && auth.isAuthenticated() && !credentialAttempt) {
        auth.expireLocally();
        void router.navigate(['/auth/login'], { queryParams: { returnUrl: router.url } });
      }
      return throwError(() => toApiError(error));
    }),
  );
};
