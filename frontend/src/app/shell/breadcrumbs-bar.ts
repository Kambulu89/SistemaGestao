import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Icon } from '../ui/icon';

@Component({
  selector: 'app-breadcrumbs-bar',
  imports: [RouterLink, Icon],
  template: `
    @if (breadcrumbs.crumbs().length > 0) {
      <nav aria-label="Localização" class="no-print mb-3 text-sm">
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
    }
  `,
})
export class BreadcrumbsBar {
  protected readonly breadcrumbs = inject(Breadcrumbs);
}
