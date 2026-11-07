import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Favorites, cleanPath } from '../core/personal';
import { Workspace } from '../core/workspace';
import { Icon } from '../ui/icon';
import { ToastService } from '../ui/toasts';

/** Trilho de navegação e o botão para marcar a página actual como favorita (guardado no servidor). */
@Component({
  selector: 'app-breadcrumbs-bar',
  imports: [RouterLink, Icon],
  template: `
    @if (breadcrumbs.crumbs().length > 0) {
      <div class="no-print mb-3 flex items-center gap-2">
        <nav aria-label="Localização" class="min-w-0 flex-1 text-sm">
          <ol class="flex flex-wrap items-center gap-1 text-muted">
            @for (c of breadcrumbs.crumbs(); track c.url; let last = $last) {
              <li class="flex items-center gap-1">
                @if (last) {
                  <span aria-current="page" class="text-fg">{{ c.label }}</span>
                } @else {
                  <a [routerLink]="c.url" class="btn-link font-normal">{{ c.label }}</a>
                  <app-icon name="chevronRight" [size]="14" />
                }
              </li>
            }
          </ol>
        </nav>
        @if (workspace.context() && current(); as page) {
          <button
            type="button"
            class="btn-ghost px-2"
            data-testid="favorite-toggle"
            [attr.aria-pressed]="isFavorite()"
            [attr.aria-label]="isFavorite() ? 'Retirar dos favoritos' : 'Adicionar aos favoritos'"
            [attr.title]="isFavorite() ? 'Retirar dos favoritos' : 'Adicionar aos favoritos'"
            [disabled]="favorites.saving()"
            (click)="toggle(page)"
          >
            <app-icon name="star" [class.text-warning]="isFavorite()" />
          </button>
        }
      </div>
    }
  `,
})
export class BreadcrumbsBar {
  protected readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly favorites = inject(Favorites);
  protected readonly workspace = inject(Workspace);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);

  protected readonly current = computed(() => {
    const crumbs = this.breadcrumbs.crumbs();
    const last = crumbs[crumbs.length - 1];
    const path = cleanPath(this.router.url);
    return last && path ? { path, title: last.label } : null;
  });
  protected readonly isFavorite = computed(() => {
    const page = this.current();
    return !!page && this.favorites.list().some((f) => f.path === page.path);
  });

  protected async toggle(page: { path: string; title: string }) {
    const adding = !this.isFavorite();
    try {
      await this.favorites.toggle(page);
      this.toasts.show(adding ? 'Adicionado aos favoritos.' : 'Retirado dos favoritos.');
    } catch {
      this.toasts.show('Não foi possível guardar os favoritos.', 'error');
    }
  }
}
