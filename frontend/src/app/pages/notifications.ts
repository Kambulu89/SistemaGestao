import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { Pager } from '../ui/pager';
import { type Notification, subjectLink } from './dashboard';

const LIMIT = 30;

@Component({
  selector: 'app-notifications',
  imports: [RouterLink, PageHeader, ErrorAlert, Pager],
  template: `
    <app-page-header title="Notificações" [subtitle]="unread() + ' por ler'">
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" [checked]="onlyUnread()" (change)="toggleUnread()" /> Só por ler
      </label>
      <button
        type="button"
        class="btn-secondary"
        [disabled]="unread() === 0 || action.busy()"
        (click)="readAll()"
      >
        Marcar todas como lidas
      </button>
    </app-page-header>
    <app-error-alert [error]="page.error() ?? action.error()" />
    @if (page.loading()) {
      <p class="text-sm text-muted">A carregar…</p>
    } @else if ((page.value()?.items ?? []).length === 0) {
      <p class="card text-sm text-muted">Sem notificações.</p>
    } @else {
      <ul class="card divide-y divide-border p-0" data-testid="notifications">
        @for (n of page.value()?.items; track n.id) {
          <li class="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
            <div class="text-sm">
              <p [class.font-semibold]="!n.readAt">{{ n.title }}</p>
              @if (n.body) {
                <p class="text-muted">{{ n.body }}</p>
              }
              <p class="text-xs text-muted">{{ when(n.createdAt) }}</p>
            </div>
            <div class="flex gap-2">
              @if (link(n.subjectType, n.subjectId); as target) {
                <a class="btn-secondary" [routerLink]="target" (click)="markRead(n)">Abrir</a>
              }
              @if (!n.readAt) {
                <button type="button" class="btn-secondary" (click)="markRead(n)">
                  Marcar como lida
                </button>
              }
            </div>
          </li>
        }
      </ul>
      <app-pager
        [total]="page.value()?.total ?? 0"
        [limit]="limit"
        [offset]="offset()"
        (offsetChange)="go($event)"
      />
    }
  `,
})
export class Notifications {
  private readonly api = inject(Api);
  protected readonly limit = LIMIT;
  protected readonly offset = signal(0);
  protected readonly onlyUnread = signal(false);
  protected readonly unread = signal(0);
  protected readonly when = formatDateTime;
  protected readonly link = subjectLink;
  protected readonly action = new Action();
  protected readonly page = new Loadable(async () => {
    const r = await this.api.getWithMeta<Notification[]>('me/notifications', {
      limit: LIMIT,
      offset: this.offset(),
      unread: this.onlyUnread() || undefined,
    });
    this.unread.set(Number(r.meta['unread'] ?? 0));
    return { items: r.data, total: Number(r.meta['total'] ?? 0) };
  });

  constructor() {
    void this.page.load();
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected toggleUnread() {
    this.onlyUnread.set(!this.onlyUnread());
    this.go(0);
  }

  protected async markRead(n: Notification) {
    if (n.readAt) return;
    await this.action.run(() => this.api.post(`me/notifications/${n.id}/read`));
    await this.page.load();
  }

  protected async readAll() {
    await this.action.run(() => this.api.post('me/notifications/read-all'));
    await this.page.load();
  }
}
