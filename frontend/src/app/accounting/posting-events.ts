import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import { EVENT_STATUS, eventErrorText, type PostingEventView } from './model';
import { accountingDeps } from './shared';

const LIMIT = 25;

/** Eventos recebidos pelo motor: o que foi contabilizado, o que ficou em rascunho e o que falhou (com a razão). */
@Component({
  selector: 'app-posting-events',
  imports: [FormsModule, RouterLink, PageHeader, DataTable, CellDef, ErrorAlert],
  template: `
    <app-page-header
      title="Eventos contabilísticos"
      subtitle="Cada evento é processado uma única vez por referência. Os que falharam podem ser reprocessados depois de corrigida a causa."
    />
    <form class="mb-4 flex flex-wrap items-end gap-2" role="search" (ngSubmit)="go(0)">
      <div>
        <label class="label" for="q">Referência</label>
        <input id="q" name="q" type="search" class="input w-56" [(ngModel)]="q" />
      </div>
      <div>
        <label class="label" for="status">Estado</label>
        <select
          id="status"
          name="status"
          class="input w-44"
          [(ngModel)]="status"
          (ngModelChange)="go(0)"
        >
          <option value="">Todos</option>
          @for (s of statuses; track s[0]) {
            <option [value]="s[0]">{{ s[1] }}</option>
          }
        </select>
      </div>
      <button type="submit" class="btn-secondary">Pesquisar</button>
    </form>
    <app-error-alert [error]="action.error()" />
    <app-data-table
      label="Eventos contabilísticos"
      [columns]="columns"
      [rows]="page.value()?.items ?? []"
      [total]="page.value()?.total ?? 0"
      [loading]="page.loading()"
      [error]="page.error()"
      [offset]="offset()"
      [limit]="limit"
      emptyText="Sem eventos."
      (offsetChange)="go($event)"
      (retry)="page.load()"
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
  `,
})
export class PostingEvents {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly limit = LIMIT;
  protected readonly statuses = Object.entries(EVENT_STATUS);
  protected readonly canPost = computed(() => this.deps.workspace.can('accounting.post'));
  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly offset = signal(0);
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
    { key: 'occurredOn', label: 'Data', value: (r) => formatDate(r.occurredOn) },
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
  protected readonly page = new Loadable(() =>
    this.deps.api.page<PostingEventView>('accounting/posting-events', {
      q: this.q().trim() || undefined,
      status: this.status() || undefined,
      legalEntityId: this.deps.workspace.legalEntityId() ?? undefined,
      limit: LIMIT,
      offset: this.offset(),
    }),
  );

  constructor() {
    void this.page.load();
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected async retry(e: PostingEventView) {
    const result = await this.action.run(() =>
      this.deps.api.post<PostingEventView>(`accounting/posting-events/${e.id}/retry`, {}),
    );
    if (result) this.toasts.show(`Evento ${result.sourceRef} reprocessado.`);
    await this.page.load();
  }
}
