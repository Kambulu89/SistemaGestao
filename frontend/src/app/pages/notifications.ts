import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { type Notification, subjectLink } from './dashboard';

const LIMIT = 30;

@Component({
  selector: 'app-notifications',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, ErrorAlert],
  template: `
    <app-entity-list-page title="Notificações" [subtitle]="unread() + ' por ler'">
      <button
        actions
        type="button"
        class="btn-secondary"
        [disabled]="unread() === 0 || action.busy()"
        (click)="readAll()"
      >
        Marcar todas como lidas
      </button>
      <app-filter-bar
        id="notif"
        label="notificações"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-error-alert [error]="action.error()" />
      <app-data-table
        label="Notificações"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="list.activeFilters() ? 'Nada por ler.' : 'Sem notificações.'"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="title" let-n>
          <p [class.font-semibold]="!n.readAt">{{ n.title }}</p>
          @if (n.body) {
            <p class="text-xs text-muted">{{ n.body }}</p>
          }
        </ng-template>
        <ng-template appCell="actions" let-n>
          <div class="flex flex-wrap justify-end gap-2">
            @if (link(n.subjectType, n.subjectId); as target) {
              <a class="btn-secondary" [routerLink]="target" (click)="markRead(n)">Abrir</a>
            }
            @if (!n.readAt) {
              <button type="button" class="btn-secondary" (click)="markRead(n)">
                Marcar como lida
              </button>
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Notifications {
  private readonly api = inject(Api);
  protected readonly unread = signal(0);
  protected readonly link = subjectLink;
  protected readonly action = new Action();
  protected readonly filters: FilterDef[] = [
    { key: 'unread', label: 'Mostrar', options: [{ value: 'true', label: 'Só por ler' }] },
  ];
  protected readonly columns: Column<Notification>[] = [
    { key: 'title', label: 'Notificação', required: true },
    { key: 'createdAt', label: 'Quando', value: (n) => formatDateTime(n.createdAt) },
    { key: 'actions', label: 'Acções', align: 'end', required: true },
  ];
  protected readonly list = new ListState<Notification>(this.api, {
    url: 'me/notifications',
    filterKeys: ['unread'],
    limit: LIMIT,
  });

  constructor() {
    void this.refreshUnread();
  }

  /** Contador de por ler (a lista pode estar filtrada ou noutra página). */
  private async refreshUnread() {
    try {
      const r = await this.api.getWithMeta<Notification[]>('me/notifications', { limit: 1 });
      this.unread.set(Number(r.meta['unread'] ?? 0));
    } catch {
      /* informativo */
    }
  }

  protected async markRead(n: Notification) {
    if (n.readAt) return;
    await this.action.run(() => this.api.post(`me/notifications/${n.id}/read`));
    await Promise.all([this.list.reload(), this.refreshUnread()]);
  }

  protected async readAll() {
    await this.action.run(() => this.api.post('me/notifications/read-all'));
    await Promise.all([this.list.reload(), this.refreshUnread()]);
  }
}
