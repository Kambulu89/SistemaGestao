import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { PLATFORM_PERMISSIONS } from '../permissions/permission.model';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/** Decide a "casa" do utilizador: login, plataforma, último tenant ou sem acesso. */
export const homeRedirectGuard: CanActivateFn = () => {
  const router = inject(Router);
  if (!inject(AuthService).isAuthenticated()) return router.createUrlTree(['/auth/login']);
  if (inject(PermissionService).can(PLATFORM_PERMISSIONS.access)) {
    return router.createUrlTree(['/platform']);
  }
  return inject(TenantContextService)
    .preferredSlug()
    .pipe(map((slug) => router.createUrlTree(slug ? ['/t', slug] : ['/auth/no-access'])));
};
