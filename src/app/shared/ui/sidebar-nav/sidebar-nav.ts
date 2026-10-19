import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Icon } from '../icon/icon';

export interface SidebarItem {
  readonly label: string;
  readonly path: string;
  readonly icon: string;
  readonly exact?: boolean;
}

export interface SidebarGroup {
  readonly id: string;
  readonly label?: string;
  readonly items: readonly SidebarItem[];
}

export type SidebarTone = 'default' | 'inverse';

const ITEM_BASE =
  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors';

const TONES: Record<SidebarTone, { item: string; active: string; label: string }> = {
  default: {
    item: `${ITEM_BASE} text-fg-muted hover:bg-surface-muted hover:text-fg`,
    active: 'bg-brand-50 !text-brand-700 dark:bg-brand-950 dark:!text-brand-300',
    label: 'text-fg-muted',
  },
  inverse: {
    item: `${ITEM_BASE} text-slate-300 hover:bg-slate-800 hover:text-white`,
    active: 'bg-slate-800 !text-white',
    label: 'text-slate-400',
  },
};

@Component({
  selector: 'app-sidebar-nav',
  imports: [RouterLink, RouterLinkActive, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <nav aria-label="Principal" class="space-y-6 p-3">
      @for (group of groups(); track group.id) {
        <div>
          @if (group.label; as label) {
            <p
              class="mb-1 px-3 text-xs font-semibold uppercase tracking-wide"
              [class]="styles().label"
            >
              {{ label }}
            </p>
          }
          <ul class="space-y-1">
            @for (item of group.items; track item.path) {
              <li>
                <a
                  [routerLink]="item.path"
                  [class]="styles().item"
                  [routerLinkActive]="styles().active"
                  [routerLinkActiveOptions]="{ exact: item.exact ?? false }"
                  ariaCurrentWhenActive="page"
                >
                  <app-icon [name]="item.icon" />
                  {{ item.label }}
                </a>
              </li>
            }
          </ul>
        </div>
      }
    </nav>
  `,
})
export class SidebarNav {
  readonly groups = input.required<readonly SidebarGroup[]>();
  readonly tone = input<SidebarTone>('default');

  protected styles() {
    return TONES[this.tone()];
  }
}
