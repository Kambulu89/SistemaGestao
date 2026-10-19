import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { forkJoin, map } from 'rxjs';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/** Valida que o utilizador pertence ao tenant do URL e carrega o respectivo contexto. */
export const tenantGuard: CanActivateFn = (route) => {
  const router = inject(Router);
  const slug = route.paramMap.get('tenantSlug') ?? '';

  return forkJoin([
    inject(TenantContextService).activate(slug),
    inject(ModuleRegistryService).ensureCatalog(),
  ]).pipe(map(([context]) => context !== null || router.createUrlTree(['/auth/no-access'])));
};
