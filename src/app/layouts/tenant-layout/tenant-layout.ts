import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppConfigService } from '../../core/config/app-config.service';
import { BreadcrumbService } from '../../core/navigation/breadcrumb.service';
import { NavigationService } from '../../core/navigation/navigation.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { Breadcrumb } from '../../shared/ui/breadcrumb/breadcrumb';
import { Shell } from '../../shared/ui/shell/shell';
import { SidebarNav } from '../../shared/ui/sidebar-nav/sidebar-nav';
import { ThemeToggle } from '../components/theme-toggle/theme-toggle';
import { UserMenu } from '../components/user-menu/user-menu';
import { TenantSwitcher } from './tenant-switcher/tenant-switcher';

/** Área de trabalho de uma organização: menu dinâmico (módulos × permissões) e selector de tenant. */
@Component({
  selector: 'app-tenant-layout',
  imports: [RouterOutlet, Shell, SidebarNav, Breadcrumb, ThemeToggle, UserMenu, TenantSwitcher],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-shell>
      <div shellBrand class="flex min-w-0 items-center gap-2">
        <span
          class="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-600 font-bold text-white"
          aria-hidden="true"
        >
          S
        </span>
        <span class="truncate text-sm font-semibold">{{ appName }}</span>
      </div>

      <app-sidebar-nav shellNav [groups]="nav.tenantNav()" />

      <div shellHeader class="flex w-full items-center justify-between gap-3">
        <app-tenant-switcher />
        <div class="flex items-center gap-1">
          <app-theme-toggle />
          <app-user-menu area="tenant" />
        </div>
      </div>

      @if (breadcrumbs().length > 1) {
        <app-breadcrumb class="mb-4 block" [items]="breadcrumbs()" />
      }
      <router-outlet />
    </app-shell>
  `,
})
export class TenantLayout {
  protected readonly nav = inject(NavigationService);
  protected readonly appName = inject(AppConfigService).appName;
  private readonly tenant = inject(TenantContextService).tenant;
  private readonly crumbs = inject(BreadcrumbService).breadcrumbs;

  protected readonly breadcrumbs = computed(() => {
    const tenant = this.tenant();
    const root = tenant ? [{ label: tenant.name, path: `/t/${tenant.slug}` }] : [];
    return [...root, ...this.crumbs()];
  });
}
