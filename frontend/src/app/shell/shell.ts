import { Component, inject, signal, viewChild } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Preferences } from '../core/preferences';
import { Icon } from '../ui/icon';
import { BreadcrumbsBar } from './breadcrumbs-bar';
import { NotificationMenu } from './notification-menu';
import { ScopeSelector } from './scope-selector';
import { Sidebar } from './sidebar';
import { TenantSwitcher } from './tenant-switcher';
import { UserMenu } from './user-menu';
import { Toasts } from '../ui/toasts';
import { GlobalSearch } from './global-search';
import { ConfirmHost } from '../ui/confirm';
import { Breadcrumbs } from '../core/breadcrumbs';

/** Moldura autenticada: barra lateral, barra superior (empresa, âmbito, pesquisa, notificações, conta) e conteúdo. */
@Component({
  selector: 'app-shell',
  // Não devolver `false` aqui: o Angular faria preventDefault e anularia o Escape dos diálogos nativos.
  host: { '(document:keydown.escape)': 'onEscape()' },
  imports: [
    RouterOutlet,
    Icon,
    Sidebar,
    TenantSwitcher,
    ScopeSelector,
    NotificationMenu,
    UserMenu,
    BreadcrumbsBar,
    Toasts,
    GlobalSearch,
    ConfirmHost,
  ],
  template: `
    <a
      href="#conteudo"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2 focus:text-fg"
    >
      Saltar para o conteúdo
    </a>
    <div class="flex min-h-screen bg-bg text-fg">
      <div
        class="no-print hidden shrink-0 border-r border-border bg-surface transition-[width] duration-[var(--motion-base)] lg:block"
        [class.w-64]="!prefs.sidebarCollapsed()"
        [class.w-16]="prefs.sidebarCollapsed()"
      >
        <aside class="sticky top-0 h-screen"><app-sidebar /></aside>
      </div>
      @if (drawerOpen()) {
        <div
          #drawer
          class="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <div class="absolute inset-0 bg-overlay" (click)="closeDrawer()" aria-hidden="true"></div>
          <aside
            class="relative h-full w-72 max-w-[85vw] border-r border-border bg-surface shadow-[var(--shadow-overlay)]"
          >
            <app-sidebar [drawer]="true" (closed)="closeDrawer()" (navigated)="closeDrawer()" />
          </aside>
        </div>
      }
      <div class="flex min-w-0 flex-1 flex-col">
        <header
          class="no-print sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2"
        >
          <button
            #menuButton
            type="button"
            class="btn-ghost px-2 lg:hidden"
            aria-label="Abrir menu"
            [attr.aria-expanded]="drawerOpen()"
            (click)="drawerOpen.set(true)"
          >
            <app-icon name="menu" />
          </button>
          <app-tenant-switcher />
          <app-scope-selector />
          <div class="order-last w-full md:order-none md:ml-2 md:w-auto md:flex-1">
            <app-global-search />
          </div>
          <div class="ml-auto flex items-center gap-1">
            <app-notification-menu />
            <app-user-menu />
          </div>
        </header>
        <main
          id="conteudo"
          tabindex="-1"
          class="mx-auto w-full max-w-7xl flex-1 px-4 py-5 focus:outline-none"
        >
          <app-breadcrumbs-bar />
          <router-outlet />
        </main>
      </div>
    </div>
    <app-toasts />
    <app-confirm-host />
  `,
})
export class Shell {
  protected readonly prefs = inject(Preferences);
  // Instancia o trilho cedo, para acompanhar a primeira navegação.
  protected readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly drawerOpen = signal(false);
  private readonly menuButton = viewChild<{ nativeElement: HTMLButtonElement }>('menuButton');
  private readonly drawer = viewChild<{ nativeElement: HTMLElement }>('drawer');

  /** Abre a gaveta (ecrã pequeno) e leva o foco para dentro dela; Escape ou o botão fechar devolvem-no ao menu. */
  protected openDrawer() {
    this.drawerOpen.set(true);
    setTimeout(() => this.drawer()?.nativeElement.querySelector<HTMLElement>('button, a')?.focus());
  }

  protected onEscape(): void {
    if (this.drawerOpen()) this.closeDrawer();
  }

  protected closeDrawer() {
    this.drawerOpen.set(false);
    setTimeout(() => this.menuButton()?.nativeElement.focus());
  }
}
