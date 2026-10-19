import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import type { ApiError } from '../../models/api-error.model';

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

/** Normaliza qualquer falha HTTP num `ApiError` previsível para a UI. */
export const errorInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((error: unknown) =>
      throwError(() => (error instanceof HttpErrorResponse ? toApiError(error) : error)),
    ),
  );
