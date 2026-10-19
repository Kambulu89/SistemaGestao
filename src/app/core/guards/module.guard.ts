import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { PermissionService } from '../permissions/permission.service';

/** Só deixa entrar em `modules/:moduleId[/:section]` se o módulo estiver acessível. */
export const moduleGuard: CanActivateFn = (route) => {
  const registry = inject(ModuleRegistryService);
  const permissions = inject(PermissionService);
  const moduleId = route.paramMap.get('moduleId') ?? '';
  const section = route.paramMap.get('section');

  const manifest = registry.find(moduleId);
  const sectionPermission = section
    ? manifest?.routes.find((r) => r.path === section)?.permission
    : undefined;

  const allowed =
    registry.accessOf(moduleId) === 'accessible' &&
    (!sectionPermission || permissions.can(sectionPermission));

  return allowed || inject(Router).createUrlTree(['/auth/no-access']);
};
