import { Injectable, inject, signal } from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  type RouterStateSnapshot,
  TitleStrategy,
} from '@angular/router';
import { Title } from '@angular/platform-browser';
import { filter } from 'rxjs';

export interface Crumb {
  label: string;
  url: string;
}

/**
 * Trilho de navegação a partir dos títulos das rotas (`title` estático ou resolvido). Ecrãs de detalhe podem
 * substituir o último elemento pelo nome do registo (`setCurrent`), que também passa a ser o título do documento.
 */
@Injectable({ providedIn: 'root' })
export class Breadcrumbs {
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  readonly crumbs = signal<Crumb[]>([]);

  constructor() {
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.rebuild());
  }

  setCurrent(label: string) {
    const crumbs = this.crumbs();
    if (crumbs.length === 0) return;
    this.crumbs.set([...crumbs.slice(0, -1), { ...crumbs[crumbs.length - 1], label }]);
    this.title.setTitle(`${label} · Sistema de Gestão`);
  }

  private rebuild() {
    const crumbs: Crumb[] = [];
    let snapshot: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    const segments: string[] = [];
    while (snapshot) {
      segments.push(...snapshot.url.map((s) => s.path));
      const label = snapshot.title;
      const url = '/' + segments.join('/');
      if (label && crumbs[crumbs.length - 1]?.label !== label) crumbs.push({ label, url });
      snapshot = snapshot.firstChild;
    }
    this.crumbs.set(crumbs);
  }
}

/** Título do separador: "<título da rota> · Sistema de Gestão". */
@Injectable()
export class AppTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(state: RouterStateSnapshot) {
    const own = this.buildTitle(state);
    this.title.setTitle(own ? `${own} · Sistema de Gestão` : 'Sistema de Gestão');
  }
}
