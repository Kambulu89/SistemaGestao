import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { TENANT_HEADER } from '../api/api.constants';
import { AuthService } from '../auth/auth.service';
import { APP_ENVIRONMENT } from '../config/app-environment';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/** Anexa credenciais e tenant activo, apenas a pedidos para a nossa API. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(inject(APP_ENVIRONMENT).apiUrl)) return next(req);

  const token = inject(AuthService).accessToken();
  const tenantId = inject(TenantContextService).tenant()?.id;

  let headers = req.headers;
  if (token) headers = headers.set('Authorization', `Bearer ${token}`);
  if (tenantId) headers = headers.set(TENANT_HEADER, tenantId);

  return next(req.clone({ headers }));
};
