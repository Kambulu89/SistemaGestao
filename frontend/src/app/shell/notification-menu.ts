import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { type Notification, subjectLink } from '../pages/dashboard';
import { formatDateTime } from '../ui/dates';
import { Modal } from '../ui/modal';
import { Icon } from '../ui/icon';

/**
 * NotificationCenter: sino com o contador de não lidas; abre uma gaveta lateral com "Por ler" / "Todas", marcar como
 * lida (uma ou todas) e ligação ao assunto. Recarrega o contador a cada navegação.
 */
@Component({
  selector: 'app-notification-menu',
  imports: [Modal, Icon, RouterLink],
  template: `
    @if (workspace.context()) {
      <button
        type="button"
        class="btn-ghost relative px-2"
        [attr.aria-label]="'Notificações: ' + unread() + ' por ler'"
        aria-haspopup="dialog"
        data-testid="unread"
        (click)="openCenter()"
      >
        <app-icon name="bell" [size]="20" />
        @if (unread() > 0) {
          <span class="badge absolute -top-1 -right-1 bg-danger px-1.5 text-on-danger">{{
            unread() > 99 ? '99+' : unread()
          }}</span>
        }
      </button>
      <app-modal title="Notificações" [open]="open()" [side]="true" (closed)="open.set(false)">
        <div data-testid="notification-center">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="Filtro" class="flex gap-1">
              <button
                type="button"
                role="tab"
                class="btn-ghost px-3"
                [attr.aria-selected]="onlyUnread()"
                [class.bg-primary-soft]="onlyUnread()"
                [class.text-on-primary-soft]="onlyUnread()"
                (click)="setFilter(true)"
              >
                Por ler ({{ unread() }})
              </button>
              <button
                type="button"
                role="tab"
                class="btn-ghost px-3"
                [attr.aria-selected]="!onlyUnread()"
                [class.bg-primary-soft]="!onlyUnread()"
                [class.text-on-primary-soft]="!onlyUnread()"
                (click)="setFilter(false)"
              >
                Todas
              </button>
            </div>
            <button type="button" class="btn-link" [disabled]="unread() === 0" (click)="readAll()">
              Marcar todas como lidas
            </button>
          </div>
          @if (loading() && items().length === 0) {
            <p class="text-sm text-muted">A carregar…</p>
          } @else if (items().length === 0) {
            <p class="py-6 text-center text-sm text-muted">
              {{ onlyUnread() ? 'Nada por ler.' : 'Sem notificações.' }}
            </p>
          }
          <ul class="divide-y divide-border">
            @for (n of items(); track n.id) {
              <li class="flex items-start gap-2 py-2">
                <span
                  class="mt-1.5 size-2 shrink-0 rounded-full"
                  [class.bg-primary]="!n.readAt"
                  aria-hidden="true"
                ></span>
                <div class="min-w-0 flex-1">
                  @if (link(n.subjectType, n.subjectId); as href) {
                    <a
                      class="btn-link block text-left font-normal"
                      [class.font-semibold]="!n.readAt"
                      [routerLink]="href"
                      (click)="markRead(n); open.set(false)"
                      >{{ n.title }}</a
                    >
                  } @else {
                    <p class="text-sm" [class.font-semibold]="!n.readAt">{{ n.title }}</p>
                  }
                  @if (n.body) {
                    <p class="text-xs text-muted">{{ n.body }}</p>
                  }
                  <p class="text-xs text-muted">
                    {{ when(n.createdAt) }}{{ n.readAt ? '' : ' · por ler' }}
                  </p>
                </div>
                @if (!n.readAt) {
                  <button
                    type="button"
                    class="btn-ghost px-2 text-xs"
                    [attr.aria-label]="'Marcar como lida: ' + n.title"
                    (click)="markRead(n)"
                  >
                    Lida
                  </button>
                }
              </li>
            }
          </ul>
        </div>
        <ng-container actions>
          <a routerLink="/notificacoes" class="btn-secondary" (click)="open.set(false)"
            >Abrir caixa completa</a
          >
        </ng-container>
      </app-modal>
    }
  `,
})
export class NotificationMenu {
  protected readonly workspace = inject(Workspace);
  private readonly api = inject(Api);
  protected readonly unread = signal(0);
  protected readonly items = signal<Notification[]>([]);
  protected readonly open = signal(false);
  protected readonly onlyUnread = signal(true);
  protected readonly loading = signal(false);
  protected readonly when = formatDateTime;
  protected readonly link = subjectLink;
  private seq = 0;

  constructor() {
    void this.refresh();
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => void this.refresh());
  }

  /** Contador e, com a gaveta aberta, a lista do filtro actual. */
  async refresh() {
    if (!this.workspace.context()) return;
    const seq = ++this.seq;
    this.loading.set(true);
    try {
      const page = await this.api.getWithMeta<Notification[]>('me/notifications', {
        limit: 20,
        unread: this.onlyUnread() || undefined,
      });
      if (seq !== this.seq) return;
      this.unread.set(Number(page.meta['unread'] ?? 0));
      this.items.set(page.data);
    } catch {
      /* informativo: um erro não bloqueia a página */
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  protected openCenter() {
    this.open.set(true);
    void this.refresh();
  }

  protected setFilter(onlyUnread: boolean) {
    this.onlyUnread.set(onlyUnread);
    this.items.set([]);
    void this.refresh();
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
