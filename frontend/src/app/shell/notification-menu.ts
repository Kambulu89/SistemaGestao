import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { type Notification, subjectLink } from '../pages/dashboard';
import { formatDateTime } from '../ui/dates';
import { Dropdown } from '../ui/dropdown';
import { Icon } from '../ui/icon';

/** Sino de notificações: contador de não lidas, as mais recentes ao abrir e acesso à caixa completa. */
@Component({
  selector: 'app-notification-menu',
  imports: [Dropdown, Icon, RouterLink],
  template: `
    @if (workspace.context()) {
      <app-dropdown
        [label]="'Notificações: ' + unread() + ' por ler'"
        buttonClass="btn-ghost relative px-2"
      >
        <span trigger class="relative inline-flex" data-testid="unread">
          <app-icon name="bell" [size]="20" />
          @if (unread() > 0) {
            <span class="badge absolute -top-2 -right-2 bg-danger px-1.5 text-on-danger">{{
              unread() > 99 ? '99+' : unread()
            }}</span>
          }
        </span>
        <div class="w-80" (focusin)="loadLatest()">
          <div class="flex items-center justify-between px-3 py-2">
            <p class="font-semibold">Notificações</p>
            <button
              type="button"
              data-menu-item
              class="btn-link"
              [disabled]="unread() === 0"
              (click)="readAll()"
            >
              Marcar todas como lidas
            </button>
          </div>
          @if (latest().length === 0) {
            <p class="px-3 py-4 text-sm text-muted">Sem notificações.</p>
          }
          <ul>
            @for (n of latest(); track n.id) {
              <li>
                <a
                  role="menuitem"
                  class="focus-ring block rounded px-3 py-2 hover:bg-surface-2"
                  [routerLink]="link(n.subjectType, n.subjectId) ?? '/notificacoes'"
                  (click)="markRead(n)"
                >
                  <span class="block text-sm" [class.font-semibold]="!n.readAt">{{ n.title }}</span>
                  <span class="text-xs text-muted">{{ when(n.createdAt) }}</span>
                </a>
              </li>
            }
          </ul>
          <a
            routerLink="/notificacoes"
            role="menuitem"
            class="focus-ring mt-1 block rounded px-3 py-2 text-center text-link hover:bg-surface-2"
            >Ver todas</a
          >
        </div>
      </app-dropdown>
    }
  `,
})
export class NotificationMenu {
  protected readonly workspace = inject(Workspace);
  private readonly api = inject(Api);
  protected readonly unread = signal(0);
  protected readonly latest = signal<Notification[]>([]);
  protected readonly when = formatDateTime;
  protected readonly link = subjectLink;

  constructor() {
    void this.refresh();
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => void this.refresh());
  }

  async refresh() {
    if (!this.workspace.context()) return;
    try {
      const page = await this.api.getWithMeta<Notification[]>('me/notifications', { limit: 5 });
      this.unread.set(Number(page.meta['unread'] ?? 0));
      this.latest.set(page.data);
    } catch {
      /* informativo: um erro não bloqueia a página */
    }
  }

  protected loadLatest() {
    if (this.latest().length === 0) void this.refresh();
  }

  protected async markRead(n: Notification) {
    if (n.readAt) return;
    try {
      await this.api.post(`me/notifications/${n.id}/read`);
    } finally {
      void this.refresh();
    }
  }

  protected async readAll() {
    try {
      await this.api.post('me/notifications/read-all');
    } finally {
      void this.refresh();
    }
  }
}
