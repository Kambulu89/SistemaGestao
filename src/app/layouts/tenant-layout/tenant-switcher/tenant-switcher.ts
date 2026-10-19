import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { TENANT_STATUS_LABELS } from '../../../core/modules/module-labels';
import type { TenantStatus } from '../../../core/tenant-context/tenant.model';
import { Badge } from '../../../shared/ui/badge/badge';
import { Dropdown } from '../../../shared/ui/dropdown/dropdown';

/** Alterna entre as organizações a que o utilizador pertence. */
@Component({
  selector: 'app-tenant-switcher',
  imports: [Dropdown, RouterLink, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-dropdown label="Alterar organização" align="start">
      <span dropdownTrigger class="flex items-center gap-2">
        <span
          class="grid size-8 place-items-center rounded-lg bg-surface-muted text-xs font-semibold"
          aria-hidden="true"
        >
          {{ tenant()?.name?.slice(0, 2)?.toUpperCase() }}
        </span>
        <span class="max-w-40 truncate text-start">
          <span class="block truncate text-sm font-medium leading-tight">{{ tenant()?.name }}</span>
          <span class="block truncate text-xs text-fg-muted">{{ context()?.roleName }}</span>
        </span>
      </span>

      <p class="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        As minhas organizações
      </p>
      @for (m of memberships(); track m.tenant.id) {
        <a
          [routerLink]="['/t', m.tenant.slug]"
          [attr.aria-current]="m.tenant.id === tenant()?.id ? 'true' : null"
          class="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm hover:bg-surface-muted"
          [class.bg-surface-muted]="m.tenant.id === tenant()?.id"
        >
          <span class="min-w-0">
            <span class="block truncate font-medium">{{ m.tenant.name }}</span>
            <span class="block truncate text-xs text-fg-muted">{{ m.roleName }}</span>
          </span>
          <app-badge [tone]="status(m.tenant.status).tone">
            {{ status(m.tenant.status).label }}
          </app-badge>
        </a>
      }
    </app-dropdown>
  `,
})
export class TenantSwitcher {
  private readonly tenantContext = inject(TenantContextService);

  protected readonly tenant = this.tenantContext.tenant;
  protected readonly context = this.tenantContext.active;
  protected readonly memberships = this.tenantContext.memberships;

  protected status(status: TenantStatus) {
    return TENANT_STATUS_LABELS[status];
  }
}
