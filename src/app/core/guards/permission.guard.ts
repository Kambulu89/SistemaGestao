import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import type { Permission } from '../permissions/permission.model';
import { PermissionService } from '../permissions/permission.service';

export function requirePermission(permission: Permission): CanActivateFn {
  return () =>
    inject(PermissionService).can(permission) || inject(Router).createUrlTree(['/auth/no-access']);
}
