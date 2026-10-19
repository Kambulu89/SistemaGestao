import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../icon/icon';

export interface BreadcrumbItem {
  readonly label: string;
  readonly path: string;
}

@Component({
  selector: 'app-breadcrumb',
  imports: [RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Localização">
      <ol class="flex flex-wrap items-center gap-1 text-sm text-fg-muted">
        @for (item of items(); track item.path; let last = $last) {
          <li class="flex items-center gap-1">
            @if (last) {
              <span aria-current="page" class="font-medium text-fg">{{ item.label }}</span>
            } @else {
              <a [routerLink]="item.path" class="rounded hover:text-fg hover:underline">
                {{ item.label }}
              </a>
              <app-icon name="chevron-right" class="size-4" />
            }
          </li>
        }
      </ol>
    </nav>
  `,
})
export class Breadcrumb {
  readonly items = input.required<readonly BreadcrumbItem[]>();
}
