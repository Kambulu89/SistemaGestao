import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Preferences, type Theme } from '../core/preferences';
import { Session } from '../core/session';
import { Workspace } from '../core/workspace';
import { Dropdown } from '../ui/dropdown';
import { Icon } from '../ui/icon';

/** Conta, tema, densidade e saída. */
@Component({
  selector: 'app-user-menu',
  imports: [Dropdown, Icon, RouterLink],
  template: `
    <app-dropdown
      [label]="'Conta de ' + (session.user()?.fullName ?? '')"
      buttonClass="btn-ghost px-2"
      [closeOnSelect]="false"
    >
      <span trigger class="flex items-center gap-2">
        <span
          class="flex size-7 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-on-primary-soft"
          aria-hidden="true"
          >{{ initials() }}</span
        >
        <span class="hidden max-w-40 truncate text-sm md:inline">{{
          session.user()?.fullName
        }}</span>
      </span>
      <div class="w-64">
        <div class="px-3 py-2">
          <p class="truncate font-semibold">{{ session.user()?.fullName }}</p>
          <p class="truncate text-xs text-muted">{{ session.user()?.email }}</p>
        </div>
        <hr class="my-1 border-border" />
        <a
          routerLink="/perfil"
          role="menuitem"
          class="focus-ring flex items-center gap-2 rounded px-3 py-2 hover:bg-surface-2"
          ><app-icon name="user" />A minha conta</a
        >
        <p
          class="mt-2 px-3 text-xs font-semibold tracking-wide text-muted uppercase"
          id="theme-label"
        >
          Tema
        </p>
        <div role="group" aria-labelledby="theme-label" class="flex gap-1 px-3 py-1">
          @for (t of themes; track t.value) {
            <button
              type="button"
              role="menuitemradio"
              [attr.aria-checked]="prefs.theme() === t.value"
              class="btn-secondary flex-1 px-2 py-1 text-xs"
              [class.bg-primary-soft]="prefs.theme() === t.value"
              (click)="prefs.theme.set(t.value)"
            >
              {{ t.label }}
            </button>
          }
        </div>
        <label class="flex items-center justify-between px-3 py-2 text-sm">
          Modo compacto
          <input
            type="checkbox"
            data-menu-item
            [checked]="prefs.density() === 'compact'"
            (change)="prefs.density.set($any($event.target).checked ? 'compact' : 'comfortable')"
          />
        </label>
        <hr class="my-1 border-border" />
        <button
          type="button"
          role="menuitem"
          class="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-surface-2"
          (click)="logout()"
        >
          <app-icon name="logout" />Sair
        </button>
      </div>
    </app-dropdown>
  `,
})
export class UserMenu {
  protected readonly session = inject(Session);
  protected readonly prefs = inject(Preferences);
  private readonly workspace = inject(Workspace);
  private readonly router = inject(Router);
  protected readonly themes: { value: Theme; label: string }[] = [
    { value: 'light', label: 'Claro' },
    { value: 'dark', label: 'Escuro' },
    { value: 'system', label: 'Sistema' },
  ];

  protected initials() {
    const name = this.session.user()?.fullName ?? '';
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('');
  }

  protected async logout() {
    await this.session.logout();
    this.workspace.reset();
    await this.router.navigateByUrl('/entrar');
  }
}
