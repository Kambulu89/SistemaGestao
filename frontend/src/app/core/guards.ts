import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { Session } from './session';
import { Workspace } from './workspace';

/** Exige sessão; sem ela vai para o login (guardando o destino). */
export const authGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const ok = await inject(Session).ensure();
  return ok || router.createUrlTree(['/entrar'], { queryParams: { next: state.url } });
};

/** Só para quem não tem sessão (login, recuperação). */
export const guestGuard: CanActivateFn = async () => {
  const ok = await inject(Session).ensure();
  return ok ? inject(Router).createUrlTree(['/']) : true;
};

/**
 * Exige empresa carregada. Se houver escolha guardada tenta-a; se só houver uma empresa disponível escolhe-a; caso
 * contrário vai para a escolha de empresa.
 */
export const tenantGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const session = inject(Session);
  const workspace = inject(Workspace);
  if (workspace.context()) return true;
  const available = session.available();
  const stored = workspace.tenantId();
  const candidate =
    stored && available.some((t) => t.id === stored)
      ? stored
      : available.length === 1
        ? available[0].id
        : null;
  if (!candidate) {
    workspace.reset();
    return router.createUrlTree(['/empresas']);
  }
  try {
    await workspace.select(candidate);
    return true;
  } catch {
    return router.createUrlTree(['/empresas']);
  }
};

/** Exige a permissão (e a funcionalidade, se indicada) em `data`. Negar por omissão. */
export const accessGuard: CanActivateFn = (route) => {
  const workspace = inject(Workspace);
  const permission = route.data['permission'] as string | undefined;
  // `anyOf`: basta uma destas permissões.
  const anyOf = route.data['anyOf'] as string[] | undefined;
  const feature = route.data['feature'] as string | undefined;
  // `anyScope`: basta a permissão nalgum âmbito (a API filtra os registos pelo âmbito do membro).
  const anyScope = route.data['anyScope'] === true;
  const check = (p: string) => (anyScope ? workspace.canAny(p) : workspace.can(p));
  const allowed =
    (!permission || check(permission)) &&
    (!anyOf || anyOf.some(check)) &&
    (!feature || workspace.has(feature));
  return allowed || inject(Router).createUrlTree(['/sem-acesso']);
};

export const platformGuard: CanActivateFn = () =>
  inject(Session).user()?.isPlatformAdmin === true || inject(Router).createUrlTree(['/sem-acesso']);
