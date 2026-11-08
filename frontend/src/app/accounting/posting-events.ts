import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { ToastService } from '../ui/toasts';
import { EVENT_STATUS, eventErrorText, type PostingEventView } from './model';
import { accountingDeps } from './shared';

const LIMIT = 25;

/** Eventos recebidos pelo motor: o que foi contabilizado, o que ficou em rascunho e o que falhou (com a razão). */
@Component({
  selector: 'app-posting-events',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, ErrorAlert],
  template: `
    <app-entity-list-page
      title="Eventos contabilísticos"
      subtitle="Cada evento é processado uma única vez por referência. Os que falharam podem ser reprocessados depois de corrigida a causa."
      permission="accounting.read"
      feature="accounting"
    >
      <app-filter-bar
        id="ev"
        label="eventos"
        placeholder="Referência"
        [state]="list"
        [filters]="filters"
      />
      <app-error-alert [error]="action.error()" />
      <app-data-table
        label="Eventos contabilísticos"
        tableId="acc-posting-events"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        emptyText="Sem eventos."
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ label(row.status) }}</span>
          @if (row.status === 'FAILED') {
            <p class="mt-1 max-w-sm text-xs text-danger-text">{{ errorText(row) }}</p>
          }
        </ng-template>
        <ng-template appCell="entryNumber" let-row>
          @if (row.entryId) {
            <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', row.entryId]">{{
              row.entryNumber ?? 'Rascunho'
            }}</a>
          } @else if (row.status === 'FAILED' && canPost()) {
            <button
              type="button"
              class="btn-secondary"
              [disabled]="action.busy()"
              (click)="retry(row)"
            >
              Reprocessar
            </button>
          } @else {
            —
          }
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class PostingEvents {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly statuses = Object.entries(EVENT_STATUS);
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: this.statuses.map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly canPost = computed(() => this.deps.workspace.can('accounting.post'));
  protected readonly action = new Action();
  protected readonly label = (s: PostingEventView['status']) => EVENT_STATUS[s] ?? s;
  protected readonly errorText = eventErrorText;
  protected readonly tone = (s: string) =>
    s === 'POSTED'
      ? 'bg-success-soft text-success-text'
      : s === 'FAILED'
        ? 'bg-danger-soft text-danger-text'
        : 'bg-warning-soft text-warning-text';
  protected readonly columns: Column<PostingEventView>[] = [
    { key: 'occurredOn', label: 'Data', required: true, value: (r) => formatDate(r.occurredOn) },
    { key: 'source', label: 'Origem / evento', value: (r) => `${r.source} · ${r.event}` },
    { key: 'sourceRef', label: 'Referência' },
    { key: 'ruleCode', label: 'Regra', hideOnMobile: true, value: (r) => r.ruleCode ?? '—' },
    { key: 'status', label: 'Estado' },
    { key: 'entryNumber', label: 'Lançamento' },
    {
      key: 'updatedAt',
      label: 'Actualizado',
      hideOnMobile: true,
      value: (r) => `${formatDateTime(r.updatedAt)} (${r.attempts}×)`,
    },
  ];
  protected readonly list = new ListState<PostingEventView>(this.deps.api, {
    url: 'accounting/posting-events',
    filterKeys: ['status'],
    limit: LIMIT,
    extra: () => ({ legalEntityId: this.deps.workspace.legalEntityId() ?? undefined }),
  });

  protected async retry(e: PostingEventView) {
    const result = await this.action.run(() =>
      this.deps.api.post<PostingEventView>(`accounting/posting-events/${e.id}/retry`, {}),
    );
    if (result) this.toasts.show(`Evento ${result.sourceRef} reprocessado.`);
    await this.list.reload();
  }
}
