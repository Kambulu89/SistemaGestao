import { Component, ViewChild, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../core/api';
import { Session } from '../core/session';
import { Workspace } from '../core/workspace';
import { Dropdown } from '../ui/dropdown';
import { Icon } from '../ui/icon';

/** Troca de empresa: limpa o estado e a cache da empresa anterior e volta ao painel da nova. */
@Component({
  selector: 'app-tenant-switcher',
  imports: [Dropdown, Icon, RouterLink],
  template: `
    @if (workspace.context(); as ctx) {
      <app-dropdown label="Mudar de empresa" align="start" buttonClass="btn-ghost max-w-56">
        <span trigger class="flex min-w-0 items-center gap-2" data-testid="current-tenant">
          <app-icon name="building" />
          <span class="truncate font-medium">{{ ctx.tenant.name }}</span>
          <app-icon name="chevronDown" [size]="14" />
        </span>
        <p class="px-3 py-1 text-xs font-semibold tracking-wide text-muted uppercase">Empresas</p>
        @for (t of session.available(); track t.id) {
          <button
            type="button"
            role="menuitemradio"
            [attr.aria-checked]="t.id === ctx.tenant.id"
            class="focus-ring flex w-full items-center justify-between rounded px-3 py-2 text-left hover:bg-surface-2"
            [disabled]="busy()"
            (click)="switchTo(t.id)"
          >
            <span>
              <span class="block">{{ t.name }}</span>
              <span class="text-xs text-muted">{{ t.code }}</span>
            </span>
            @if (t.id === ctx.tenant.id) {
              <app-icon name="check" />
            }
          </button>
        }
        @if (error()) {
          <p class="px-3 py-1 text-xs text-danger-text" role="alert">{{ error() }}</p>
        }
        <hr class="my-1 border-border" />
        <a
          routerLink="/empresas"
          role="menuitem"
          class="focus-ring block rounded px-3 py-2 hover:bg-surface-2"
          >Todas as empresas…</a
        >
      </app-dropdown>
    } @else {
      <a routerLink="/empresas" class="btn-link">Escolher empresa</a>
    }
  `,
})
export class TenantSwitcher {
  protected readonly session = inject(Session);
  protected readonly workspace = inject(Workspace);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  @ViewChild(Dropdown) private dropdown?: Dropdown;

  protected async switchTo(id: string) {
    if (id === this.workspace.tenantId()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.workspace.select(id);
      await this.router.navigateByUrl('/painel');
    } catch (e) {
      this.error.set(ApiError.from(e).message);
      await this.router.navigateByUrl('/empresas');
    } finally {
      this.busy.set(false);
      this.dropdown?.close(false);
    }
  }
}
