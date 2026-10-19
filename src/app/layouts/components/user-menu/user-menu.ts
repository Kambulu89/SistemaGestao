import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';
import { PLATFORM_PERMISSIONS } from '../../../core/permissions/permission.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Dropdown } from '../../../shared/ui/dropdown/dropdown';

const ITEM =
  'flex w-full items-center rounded-lg px-3 py-2 text-start text-sm text-fg hover:bg-surface-muted';

/** Menu do utilizador. Mostra a ligação para a "outra" área, quando o utilizador tem acesso a ela. */
@Component({
  selector: 'app-user-menu',
  imports: [Dropdown, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-dropdown label="Menu do utilizador" align="end">
      <span dropdownTrigger class="flex items-center gap-2">
        <span
          class="grid size-8 place-items-center rounded-full bg-brand-600 text-xs font-semibold text-white"
          aria-hidden="true"
        >
          {{ initials() }}
        </span>
        <span class="hidden max-w-40 truncate sm:block">{{ user()?.name }}</span>
      </span>

      <div class="px-3 py-2">
        <p class="truncate text-sm font-medium">{{ user()?.name }}</p>
        <p class="truncate text-xs text-fg-muted">{{ user()?.email }}</p>
      </div>
      <hr class="my-1 border-line" />

      @if (area() === 'tenant' && canAccessPlatform()) {
        <a routerLink="/platform" [class]="item">Administração da plataforma</a>
      }
      @if (area() === 'platform' && firstTenantSlug(); as slug) {
        <a [routerLink]="['/t', slug]" [class]="item">Área da organização</a>
      }
      <button type="button" [class]="item" (click)="logout()">Terminar sessão</button>
    </app-dropdown>
  `,
})
export class UserMenu implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionService);
  private readonly tenantContext = inject(TenantContextService);

  readonly area = input.required<'platform' | 'tenant'>();

  protected readonly item = ITEM;
  protected readonly user = this.auth.user;
  protected readonly initials = computed(() =>
    (this.user()?.name ?? '?')
      .split(' ')
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase(),
  );
  protected readonly canAccessPlatform = computed(() =>
    this.permissions.can(PLATFORM_PERMISSIONS.access),
  );
  protected readonly firstTenantSlug = computed(
    () => this.tenantContext.memberships()[0]?.tenant.slug ?? null,
  );

  ngOnInit(): void {
    // Na área da plataforma os tenants ainda podem não ter sido carregados.
    if (this.area() === 'platform') this.tenantContext.loadMemberships().subscribe();
  }

  protected logout(): void {
    this.auth.logout();
    void this.router.navigate(['/auth/login']);
  }
}
