import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { CSRF_HEADER, TENANT_HEADER } from '../api/api.constants';
import { AuthService } from '../auth/auth.service';
import { APP_ENVIRONMENT } from '../config/app-environment';
import { TenantContextService } from '../tenant-context/tenant-context.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Pedidos que não pertencem a nenhum tenant: o selector não se envia. */
function isTenantFree(path: string): boolean {
  return (
    path.startsWith('/auth/') ||
    path.startsWith('/platform/') ||
    path === '/me/tenants' ||
    path === '/me/password' ||
    path === '/me/security-events' ||
    path.startsWith('/me/sessions') ||
    path === '/invitations/accept'
  );
}

/**
 * Só para pedidos à nossa API: envia o cookie de sessão (`withCredentials`), o token anti-CSRF nas
 * escritas e o tenant activo como **selector** (o servidor valida-o contra a sessão e a membership;
 * nunca é prova de autorização). Um selector já definido pelo chamador não é substituído.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const apiUrl = inject(APP_ENVIRONMENT).apiUrl;
  if (!req.url.startsWith(apiUrl)) return next(req);

  let headers = req.headers;
  const csrf = inject(AuthService).csrfToken();
  if (csrf && !SAFE_METHODS.has(req.method)) headers = headers.set(CSRF_HEADER, csrf);

  const tenantId = inject(TenantContextService).tenant()?.id;
  if (tenantId && !headers.has(TENANT_HEADER) && !isTenantFree(req.url.slice(apiUrl.length))) {
    headers = headers.set(TENANT_HEADER, tenantId);
  }

  return next(req.clone({ headers, withCredentials: true }));
};
