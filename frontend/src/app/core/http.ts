import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { Session } from './session';
import { Workspace } from './workspace';

const PUBLIC = [
  '/api/v1/auth/login',
  '/api/v1/auth/password/',
  '/api/v1/auth/invitations/',
  '/api/v1/health',
];

/** Envia a empresa seleccionada em `X-Tenant-Id` e trata a sessão expirada (401) voltando ao login. */
export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const workspace = inject(Workspace);
  const session = inject(Session);
  const router = inject(Router);
  const tenantId = workspace.tenantId();
  const isApi = req.url.startsWith('/api/');
  const request =
    isApi && tenantId && !req.headers.has('x-tenant-id')
      ? req.clone({ setHeaders: { 'X-Tenant-Id': tenantId } })
      : req;
  return next(request).pipe(
    catchError((error) => {
      const publicCall = PUBLIC.some((p) => req.url.startsWith(p)) || req.url.endsWith('/auth/me');
      if (isApi && error?.status === 401 && !publicCall) {
        session.clear();
        void router.navigate(['/entrar'], { queryParams: { next: router.url } });
      }
      return throwError(() => error);
    }),
  );
};
