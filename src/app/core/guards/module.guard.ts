import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { TenantModulesService } from '../modules/tenant-modules.service';

/** Só deixa entrar numa rota de módulo (`data.moduleId`) se esse módulo estiver acessível. */
export const moduleGuard: CanActivateFn = (route) => {
  const moduleId = route.data['moduleId'] as string | undefined;
  const allowed =
    moduleId !== undefined && inject(TenantModulesService).accessOf(moduleId) === 'accessible';
  return allowed || inject(Router).createUrlTree(['/auth/no-access']);
};
