import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { takeUntil } from 'rxjs';
import { TENANT_HEADER } from '../api/api.constants';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/**
 * Cancela os pedidos em curso de um tenant quando o utilizador troca de tenant (ou sai): uma resposta
 * tardia do tenant anterior nunca pode aparecer no ecrã do novo. O pedido que carrega o contexto do
 * tenant que está a ser activado leva o seu selector explícito e é emitido já depois do cancelamento.
 * Corre depois do `authInterceptor`, por isso já vê o selector final.
 */
export const tenantScopeInterceptor: HttpInterceptorFn = (req, next) => {
  const tenantContext = inject(TenantContextService);
  if (!req.headers.has(TENANT_HEADER)) return next(req);
  return next(req).pipe(takeUntil(tenantContext.switched$));
};
