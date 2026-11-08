import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { DetailDrawer, FieldList } from '../ui/detail-drawer';
import { exportList, withoutPaging } from '../ui/export';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { Loadable } from '../ui/load';
import { formatMoney } from '../ui/money-input';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { type Entry, ENTRY_STATUS, type EntryStatus, type Journal } from './model';
import { accountingDeps } from './shared';

const LIMIT = 25;

/** Valor decimal da API com as casas que traz (sem passar por `number`). */
export function moneyOf(v: string | null | undefined) {
  if (!v) return '—';
  const scale = v.includes('.') ? v.split('.')[1].length : 0;
  return formatMoney(v, scale);
}

/**
 * Lançamentos (EntityListPage): pesquisa, estado, diário e intervalo de datas no servidor, ordenação no servidor,
 * colunas configuráveis, exportação com as colunas visíveis e vista rápida (DetailDrawer) com as linhas. O âmbito da
 * entidade legal escolhida na barra superior aplica-se sempre.
 */
@Component({
  selector: 'app-entries',
  imports: [
    RouterLink,
    EntityListPage,
    FilterBar,
    DataTable,
    CellDef,
    DetailDrawer,
    FieldList,
    Icon,
  ],
  template: `
    <app-entity-list-page
      title="Lançamentos"
      subtitle="Rascunho → submetido → aprovado → contabilizado. Contabilizado não se altera: estorna-se."
      permission="accounting.read"
      feature="accounting"
    >
      @if (canCreate()) {
        <a actions class="btn-primary" routerLink="/contabilidade/lancamentos/novo"
          ><app-icon name="plus" [size]="16" />Novo lançamento</a
        >
      }
      <app-filter-bar
        id="entries"
        label="lançamentos"
        placeholder="Número, referência ou descrição"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Lançamentos"
        tableId="accounting-entries"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [sort]="list.sort()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [exportable]="true"
        [exporting]="exporting()"
        [emptyText]="
          list.activeFilters() || list.q()
            ? 'Sem lançamentos com estes filtros.'
            : 'Ainda sem lançamentos.'
        "
        (sortChange)="list.setSort($event)"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
        (export)="export($event)"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ statusLabel(row.status) }}</span>
          @if (row.reversedById) {
            <span class="badge ml-1 bg-surface-2 text-muted">estornado</span>
          }
        </ng-template>
        <ng-template appCell="preview" let-row>
          <button
            type="button"
            class="btn-ghost px-2"
            [attr.aria-label]="
              'Vista rápida de ' + (row.number ?? 'rascunho') + ' de ' + date(row.entryDate)
            "
            data-testid="quick-view"
            (click)="preview(row)"
          >
            <app-icon name="eye" [size]="16" />
          </button>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>

    <app-detail-drawer
      [title]="drawerTitle()"
      [subtitle]="selected() ? selected()!.journalCode + ' · ' + date(selected()!.entryDate) : null"
      [open]="selected() !== null"
      [loading]="detail.loading()"
      [error]="detail.error()"
      [link]="selected() ? ['/contabilidade/lancamentos', selected()!.id] : null"
      (closed)="selected.set(null)"
      (retry)="detail.load()"
    >
      @if (detail.value(); as e) {
        <app-field-list
          [fields]="[
            { label: 'Estado', value: statusLabel(e.status) },
            { label: 'Período', value: e.fiscalYearCode + ' · ' + e.periodName },
            { label: 'Descrição', value: e.description },
            { label: 'Referência', value: e.reference },
            { label: 'Moeda', value: e.currency },
            { label: 'Total', value: money(e.totalDebit), align: 'end' },
          ]"
        />
        <h3 class="mt-4 mb-2 text-sm font-semibold">Linhas</h3>
        <div class="overflow-x-auto">
          <table class="table text-sm" aria-label="Linhas do lançamento">
            <thead>
              <tr>
                <th scope="col">Conta</th>
                <th scope="col" class="text-right">Débito</th>
                <th scope="col" class="text-right">Crédito</th>
              </tr>
            </thead>
            <tbody>
              @for (l of e.lines; track $index) {
                <tr>
                  <td>
                    <span class="font-mono text-xs">{{ l.accountCode }}</span>
                    {{ l.accountName }}
                  </td>
                  <td class="text-right tabular-nums">
                    {{ isZero(l.debit) ? '' : money(l.debit) }}
                  </td>
                  <td class="text-right tabular-nums">
                    {{ isZero(l.credit) ? '' : money(l.credit) }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </app-detail-drawer>
  `,
})
export class Entries {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly statuses = Object.entries(ENTRY_STATUS);
  protected readonly canCreate = computed(() => this.deps.workspace.can('accounting.create'));
  protected readonly journals = signal<Journal[]>([]);
  protected readonly exporting = signal(false);
  protected readonly selected = signal<Entry | null>(null);
  protected readonly date = formatDate;
  protected readonly money = moneyOf;
  protected readonly isZero = (v: string) => !v || /^0*(\.0*)?$/.test(v);
  protected readonly statusLabel = (s: EntryStatus) => ENTRY_STATUS[s] ?? s;
  protected readonly tone = (s: EntryStatus) =>
    s === 'POSTED'
      ? 'bg-success-soft text-success-text'
      : s === 'DRAFT'
        ? 'bg-surface-2 text-fg'
        : 'bg-warning-soft text-warning-text';
  protected readonly list = new ListState<Entry>(this.deps.api, {
    url: 'accounting/entries',
    filterKeys: ['status', 'journalId', 'dateFrom', 'dateTo'],
    sortFields: ['entryDate', 'number', 'totalDebit', 'status', 'journalCode'],
    limit: LIMIT,
    extra: () => ({ legalEntityId: this.deps.workspace.legalEntityId() ?? undefined }),
  });
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'status',
      label: 'Estado',
      options: this.statuses.map(([value, label]) => ({ value, label })),
    },
    {
      key: 'journalId',
      label: 'Diário',
      options: this.journals().map((j) => ({ value: j.id, label: `${j.code} — ${j.name}` })),
    },
    { key: 'dateFrom', label: 'De', type: 'date' },
    { key: 'dateTo', label: 'Até', type: 'date' },
  ]);
  protected readonly columns: Column<Entry>[] = [
    {
      key: 'entryDate',
      label: 'Data',
      sortable: true,
      required: true,
      value: (r) => formatDate(r.entryDate),
      link: (r) => ['/contabilidade/lancamentos', r.id],
    },
    { key: 'number', label: 'Número', sortable: true, value: (r) => r.number ?? '—' },
    { key: 'journalCode', label: 'Diário', sortable: true, hideOnMobile: true },
    { key: 'description', label: 'Descrição', hideOnMobile: true },
    { key: 'reference', label: 'Referência', hideOnMobile: true, hiddenByDefault: true },
    {
      key: 'periodName',
      label: 'Período',
      hideOnMobile: true,
      hiddenByDefault: true,
      value: (r) => `${r.fiscalYearCode} · ${r.periodName}`,
    },
    {
      key: 'totalDebit',
      label: 'Total',
      sortable: true,
      align: 'end',
      value: (r) => moneyOf(r.totalDebit),
    },
    { key: 'status', label: 'Estado', sortable: true, value: (r) => this.statusLabel(r.status) },
    { key: 'preview', label: 'Vista rápida', required: true, value: () => '' },
  ];
  protected readonly drawerTitle = computed(() => {
    const e = this.selected();
    return e ? (e.number ? `Lançamento ${e.number}` : 'Lançamento (rascunho)') : 'Lançamento';
  });
  protected readonly detail = new Loadable(() =>
    this.deps.api.get<Entry>(`accounting/entries/${this.selected()!.id}`),
  );

  constructor() {
    this.deps.api.page<Journal>('accounting/journals', { limit: 200 }).then(
      (p) => this.journals.set(p.items),
      () => undefined,
    );
    // Mudar a entidade legal na barra superior recarrega a lista (o âmbito vai em todos os pedidos).
    let first = true;
    effect(() => {
      this.deps.workspace.legalEntityId();
      untracked(() => {
        if (!first) void this.list.reload();
        first = false;
      });
    });
  }

  protected preview(entry: Entry) {
    this.selected.set(entry);
    void this.detail.load();
  }

  protected async export(columns: Column<Entry>[]) {
    this.exporting.set(true);
    try {
      const n = await exportList(
        this.deps.api,
        'accounting/entries',
        withoutPaging(this.list.query()),
        columns.filter((c) => c.key !== 'preview'),
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
