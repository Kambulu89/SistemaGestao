import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { Workspace } from '../core/workspace';
import { visibleNavigation } from './navigation';

/** Moldura autenticada: navegação filtrada por permissões e funcionalidades, empresa, notificações e conta. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="min-h-screen bg-slate-50 text-slate-900 lg:flex">
      <a href="#conteudo" class="sr-only focus:not-sr-only focus:absolute focus:p-2"
        >Saltar para o conteúdo</a
      >
      <aside
        class="border-b border-slate-200 bg-white lg:min-h-screen lg:w-64 lg:border-r lg:border-b-0"
      >
        <div class="flex items-center justify-between px-4 py-4">
          <a routerLink="/" class="text-base font-semibold text-indigo-700">Sistema de Gestão</a>
          <button
            type="button"
            class="btn-secondary lg:hidden"
            [attr.aria-expanded]="menuOpen()"
            aria-controls="menu"
            (click)="menuOpen.set(!menuOpen())"
          >
            Menu
          </button>
        </div>
        <nav
          id="menu"
          class="px-2 pb-4 lg:block"
          [class.hidden]="!menuOpen()"
          aria-label="Principal"
        >
          @for (group of navigation(); track group.label) {
            <p class="mt-3 px-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              {{ group.label }}
            </p>
            <ul class="mt-1">
              @for (item of group.items; track item.path) {
                <li>
                  <a
                    [routerLink]="item.path"
                    routerLinkActive="bg-indigo-50 text-indigo-800"
                    [routerLinkActiveOptions]="{ exact: item.path === '/aprovacoes' }"
                    class="block rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
                    (click)="menuOpen.set(false)"
                    >{{ item.label }}</a
                  >
                </li>
              }
            </ul>
          }
        </nav>
      </aside>
      <div class="flex-1">
        <header
          class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3"
        >
          <div class="text-sm">
            @if (workspace.context(); as ctx) {
              <span class="font-medium" data-testid="current-tenant">{{ ctx.tenant.name }}</span>
              @if (session.available().length > 1 || session.user()?.isPlatformAdmin) {
                <a routerLink="/empresas" class="btn-link ml-2">Mudar</a>
              }
            } @else {
              <a routerLink="/empresas" class="btn-link">Escolher empresa</a>
            }
          </div>
          <div class="flex items-center gap-3 text-sm">
            @if (workspace.context()) {
              <a routerLink="/notificacoes" class="btn-link" data-testid="unread">
                Notificações
                @if (unread() > 0) {
                  <span class="badge ml-1 bg-red-600 text-white">{{ unread() }}</span>
                }
              </a>
            }
            <a routerLink="/perfil" class="btn-link">{{ session.user()?.fullName }}</a>
            <button type="button" class="btn-secondary" (click)="logout()">Sair</button>
          </div>
        </header>
        <main id="conteudo" class="mx-auto max-w-6xl px-4 py-6">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
})
export class Shell {
  protected readonly session = inject(Session);
  protected readonly workspace = inject(Workspace);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly menuOpen = signal(false);
  protected readonly unread = signal(0);
  protected readonly navigation = computed(() =>
    visibleNavigation(
      (p) => this.workspace.can(p),
      (f) => this.workspace.has(f),
      this.workspace.context() !== null,
      this.session.user()?.isPlatformAdmin === true,
    ),
  );

  constructor() {
    void this.refreshUnread();
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => void this.refreshUnread());
  }

  private async refreshUnread() {
    if (!this.workspace.context()) return;
    try {
      const page = await this.api.getWithMeta<unknown[]>('me/notifications', {
        limit: 1,
        unread: true,
      });
      this.unread.set(Number(page.meta['unread'] ?? 0));
    } catch {
      /* o contador é informativo: um erro aqui não bloqueia a página */
    }
  }

  protected async logout() {
    await this.session.logout();
    this.workspace.reset();
    await this.router.navigateByUrl('/entrar');
  }
}
