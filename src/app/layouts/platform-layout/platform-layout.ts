import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppConfigService } from '../../core/config/app-config.service';
import { BreadcrumbService } from '../../core/navigation/breadcrumb.service';
import { NavigationService } from '../../core/navigation/navigation.service';
import { Badge } from '../../shared/ui/badge/badge';
import { Breadcrumb } from '../../shared/ui/breadcrumb/breadcrumb';
import { Shell } from '../../shared/ui/shell/shell';
import { SidebarNav } from '../../shared/ui/sidebar-nav/sidebar-nav';
import { ThemeToggle } from '../components/theme-toggle/theme-toggle';
import { UserMenu } from '../components/user-menu/user-menu';

/** Administração global do ecossistema SaaS. Visualmente distinta da área do tenant. */
@Component({
  selector: 'app-platform-layout',
  imports: [RouterOutlet, Shell, SidebarNav, Breadcrumb, Badge, ThemeToggle, UserMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-shell tone="inverse">
      <div shellBrand class="flex min-w-0 items-center gap-2">
        <span
          class="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-500 font-bold text-white"
          aria-hidden="true"
        >
          S
        </span>
        <span class="min-w-0">
          <span class="block truncate text-sm font-semibold leading-tight">{{ appName }}</span>
          <span class="block text-xs text-slate-400">Plataforma</span>
        </span>
      </div>

      <app-sidebar-nav shellNav tone="inverse" [groups]="nav.platformNav()" />

      <div shellHeader class="flex w-full items-center justify-between gap-3">
        <app-badge tone="brand">Administração global</app-badge>
        <div class="flex items-center gap-1">
          <app-theme-toggle />
          <app-user-menu area="platform" />
        </div>
      </div>

      @if (breadcrumbs().length > 1) {
        <app-breadcrumb class="mb-4 block" [items]="breadcrumbs()" />
      }
      <router-outlet />
    </app-shell>
  `,
})
export class PlatformLayout {
  protected readonly nav = inject(NavigationService);
  protected readonly appName = inject(AppConfigService).appName;
  private readonly crumbs = inject(BreadcrumbService).breadcrumbs;

  protected readonly breadcrumbs = computed(() => [
    { label: 'Plataforma', path: '/platform' },
    ...this.crumbs(),
  ]);
}
