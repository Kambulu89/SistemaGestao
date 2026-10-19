import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import { AuthService } from '../auth/auth.service';

function toApiError(error: HttpErrorResponse): ApiError {
  if (error.status === 0) {
    return { status: 0, message: 'Sem ligação ao servidor. Verifique a sua rede.' };
  }

  const body: unknown = error.error;
  const serverMessage =
    typeof body === 'object' && body !== null && 'message' in body
      ? String((body as { message: unknown }).message)
      : undefined;

  return {
    status: error.status,
    message: serverMessage ?? error.statusText ?? 'Ocorreu um erro inesperado.',
    details: body,
  };
}

/** Normaliza falhas HTTP em `ApiError` e termina a sessão num 401. */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) return throwError(() => error);

      if (error.status === 401 && auth.isAuthenticated()) {
        auth.logout();
        void router.navigate(['/auth/login'], { queryParams: { returnUrl: router.url } });
      }
      return throwError(() => toApiError(error));
    }),
  );
};
