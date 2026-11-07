import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { exportList, withoutPaging } from '../ui/export';
import { Icon } from '../ui/icon';
import { Loadable } from '../ui/load';
import { formatMoney } from '../ui/money-input';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import { type Entry, ENTRY_STATUS, type EntryStatus, type Journal } from './model';
import { accountingDeps } from './shared';

const LIMIT = 25;

/** Lançamentos com filtros do servidor (estado, diário, pesquisa) e âmbito da entidade legal. */
@Component({
  selector: 'app-entries',
  imports: [FormsModule, RouterLink, PageHeader, DataTable, CellDef, Icon],
  template: `
    <app-page-header
      title="Lançamentos"
      subtitle="Rascunho → submetido → aprovado → contabilizado. Contabilizado não se altera: estorna-se."
    >
      @if (canCreate()) {
        <a class="btn-primary" routerLink="/contabilidade/lancamentos/novo"
          ><app-icon name="plus" [size]="16" />Novo lançamento</a
        >
      }
    </app-page-header>
    <form class="mb-4 flex flex-wrap items-end gap-2" role="search" (ngSubmit)="go(0)">
      <div>
        <label class="label" for="q">Pesquisar</label>
        <input
          id="q"
          name="q"
          type="search"
          class="input w-64"
          placeholder="Número, referência ou descrição"
          [(ngModel)]="q"
        />
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
      <div>
        <label class="label" for="journal">Diário</label>
        <select
          id="journal"
          name="journal"
          class="input w-48"
          [(ngModel)]="journalId"
          (ngModelChange)="go(0)"
        >
          <option value="">Todos</option>
          @for (j of journals(); track j.id) {
            <option [value]="j.id">{{ j.code }} — {{ j.name }}</option>
          }
        </select>
      </div>
      <button type="submit" class="btn-secondary">Pesquisar</button>
    </form>
    <app-data-table
      label="Lançamentos"
      [columns]="columns"
      [rows]="page.value()?.items ?? []"
      [total]="page.value()?.total ?? 0"
      [loading]="page.loading()"
      [error]="page.error()"
      [offset]="offset()"
      [limit]="limit"
      [exportable]="true"
      [exporting]="exporting()"
      emptyText="Sem lançamentos."
      (offsetChange)="go($event)"
      (retry)="page.load()"
      (export)="export()"
    >
      <ng-template appCell="status" let-row>
        <span class="badge" [class]="tone(row.status)">{{ statusLabel(row.status) }}</span>
        @if (row.reversedById) {
          <span class="badge ml-1 bg-surface-2 text-muted">estornado</span>
        }
      </ng-template>
    </app-data-table>
  `,
})
export class Entries {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly limit = LIMIT;
  protected readonly statuses = Object.entries(ENTRY_STATUS);
  protected readonly canCreate = computed(() => this.deps.workspace.can('accounting.create'));
  protected readonly journals = signal<Journal[]>([]);
  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly journalId = signal('');
  protected readonly offset = signal(0);
  protected readonly exporting = signal(false);
  protected readonly statusLabel = (s: EntryStatus) => ENTRY_STATUS[s] ?? s;
  protected readonly tone = (s: EntryStatus) =>
    s === 'POSTED'
      ? 'bg-success-soft text-success-text'
      : s === 'DRAFT'
        ? 'bg-surface-2 text-fg'
        : 'bg-warning-soft text-warning-text';
  protected readonly columns: Column<Entry>[] = [
    {
      key: 'entryDate',
      label: 'Data',
      value: (r) => formatDate(r.entryDate),
      link: (r) => ['/contabilidade/lancamentos', r.id],
    },
    { key: 'number', label: 'Número', value: (r) => r.number ?? '—' },
    { key: 'journalCode', label: 'Diário', hideOnMobile: true },
    { key: 'description', label: 'Descrição', hideOnMobile: true },
    {
      key: 'totalDebit',
      label: 'Total',
      align: 'end',
      value: (r) => `${formatMoney(r.totalDebit, this.scale(r.totalDebit))}`,
    },
    { key: 'status', label: 'Estado' },
  ];
  protected readonly page = new Loadable(() =>
    this.deps.api.page<Entry>('accounting/entries', this.query()),
  );

  constructor() {
    void this.page.load();
    this.deps.api.page<Journal>('accounting/journals', { limit: 200 }).then(
      (p) => this.journals.set(p.items),
      () => undefined,
    );
  }

  private scale(v: string) {
    return v.includes('.') ? v.split('.')[1].length : 0;
  }

  private query() {
    return {
      q: this.q().trim() || undefined,
      status: this.status() || undefined,
      journalId: this.journalId() || undefined,
      legalEntityId: this.deps.workspace.legalEntityId() ?? undefined,
      limit: LIMIT,
      offset: this.offset(),
    };
  }

  protected go(offset: number) {
    this.offset.set(offset);
    void this.page.load();
  }

  protected async export() {
    this.exporting.set(true);
    try {
      const n = await exportList(
        this.deps.api,
        'accounting/entries',
        withoutPaging(this.query()),
        this.columns,
        'lancamentos.csv',
      );
      this.toasts.show(`Exportados ${n} lançamento(s).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
