import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { PLATFORM_PERMISSIONS } from '../permissions/permission.model';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/** Acesso à administração global. Sai do contexto de tenant para não enviar um tenant obsoleto. */
export const platformGuard: CanActivateFn = () => {
  if (!inject(PermissionService).can(PLATFORM_PERMISSIONS.access)) {
    return inject(Router).createUrlTree(['/auth/no-access']);
  }
  inject(TenantContextService).deactivate();
  return true;
};
