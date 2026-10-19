import { inject, Injectable, Injector, runInInjectionContext } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import type { Breadcrumb } from './navigation.model';

/**
 * Rótulo da migalha: texto fixo ou função (corre em contexto de injecção) para rótulos que
 * dependem de dados, como o nome de uma entidade. `null` omite a migalha.
 */
export type BreadcrumbLabel = string | ((route: ActivatedRouteSnapshot) => string | null);

/** Migalhas de pão a partir de `data.breadcrumb` declarado nas rotas. */
@Injectable({ providedIn: 'root' })
export class BreadcrumbService {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  readonly breadcrumbs = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => this.build(this.router.routerState.snapshot.root)),
    ),
    { initialValue: [] },
  );

  private resolve(
    fn: (route: ActivatedRouteSnapshot) => string | null,
    route: ActivatedRouteSnapshot,
  ): string | null {
    return runInInjectionContext(this.injector, () => fn(route));
  }

  private build(root: ActivatedRouteSnapshot): readonly Breadcrumb[] {
    const crumbs: Breadcrumb[] = [];
    let path = '';
    for (let route: ActivatedRouteSnapshot | null = root; route; route = route.firstChild) {
      const segment = route.url.map((s) => s.path).join('/');
      if (segment) path += `/${segment}`;
      // Dados declarados na própria rota: `route.data` também inclui o herdado do pai (rotas filhas
      // de caminho vazio), o que duplicaria a migalha.
      const declared = route.routeConfig?.data?.['breadcrumb'] as BreadcrumbLabel | undefined;
      const label = typeof declared === 'function' ? this.resolve(declared, route) : declared;
      if (label) crumbs.push({ label, path });
    }
    return crumbs;
  }
}
