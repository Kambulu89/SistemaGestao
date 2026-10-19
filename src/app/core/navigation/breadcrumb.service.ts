import { inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import type { Breadcrumb } from './navigation.model';

/** Migalhas de pão a partir de `data.breadcrumb` declarado nas rotas. */
@Injectable({ providedIn: 'root' })
export class BreadcrumbService {
  private readonly router = inject(Router);

  readonly breadcrumbs = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => this.build(this.router.routerState.snapshot.root)),
    ),
    { initialValue: [] },
  );

  private build(root: ActivatedRouteSnapshot): readonly Breadcrumb[] {
    const crumbs: Breadcrumb[] = [];
    let path = '';
    for (let route: ActivatedRouteSnapshot | null = root; route; route = route.firstChild) {
      const segment = route.url.map((s) => s.path).join('/');
      if (segment) path += `/${segment}`;
      const label = route.data['breadcrumb'] as string | undefined;
      if (label) crumbs.push({ label, path });
    }
    return crumbs;
  }
}
