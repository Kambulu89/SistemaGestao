import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/** Valida que o utilizador pertence ao tenant do URL e carrega o respectivo contexto. */
export const tenantGuard: CanActivateFn = (route) => {
  const router = inject(Router);
  const slug = route.paramMap.get('tenantSlug') ?? '';

  return inject(TenantContextService)
    .activate(slug)
    .pipe(map((context) => context !== null || router.createUrlTree(['/auth/no-access'])));
};
