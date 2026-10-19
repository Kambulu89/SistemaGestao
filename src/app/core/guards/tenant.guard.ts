import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { catchError, map, of, switchMap } from 'rxjs';
import { DynamicEntityRegistryService } from '../dynamic/entity-registry.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/**
 * Valida que o utilizador pertence ao tenant do URL e carrega o respectivo contexto e as
 * definições de entidades. Se estas falharem a carregar, o tenant continua utilizável.
 */
export const tenantGuard: CanActivateFn = (route) => {
  const router = inject(Router);
  const registry = inject(DynamicEntityRegistryService);
  const slug = route.paramMap.get('tenantSlug') ?? '';

  return inject(TenantContextService)
    .activate(slug)
    .pipe(
      switchMap((context) =>
        context
          ? registry.ensureLoaded().pipe(
              map(() => true),
              catchError(() => of(true)),
            )
          : of(router.createUrlTree(['/auth/no-access'])),
      ),
    );
};
