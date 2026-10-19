import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';

/** Exige sessão. Protecção de navegação apenas; o backend valida cada pedido. */
export const authGuard: CanActivateFn = (_route, state) => {
  if (inject(AuthService).isAuthenticated()) return true;
  return inject(Router).createUrlTree(['/auth/login'], { queryParams: { returnUrl: state.url } });
};

/** Para páginas só de visitantes (login). */
export const guestGuard: CanActivateFn = () => {
  const router = inject(Router);
  return inject(AuthService).isAuthenticated() ? router.createUrlTree(['/']) : true;
};
