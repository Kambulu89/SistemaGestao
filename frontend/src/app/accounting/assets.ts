import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { exportList, withoutPaging } from '../ui/export';
import { Icon } from '../ui/icon';
import { EntityListPage } from '../ui/templates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { ToastService } from '../ui/toasts';
import { ASSET_STATUS, type AssetClass, type AssetStatus, type FixedAsset } from './model';
import { accountingDeps, moneyText } from './shared';

const LIMIT = 25;

/** Activos fixos (EntityListPage): pesquisa, estado e classe na URL, valor líquido actual, colunas e exportação. */
@Component({
  selector: 'app-assets',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Activos fixos"
      subtitle="Fichas, aquisição, depreciação e abate. Os lançamentos são gerados e contabilizados pela ficha."
      permission="fixed_assets.read"
      feature="accounting"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/contabilidade/activos/novo"
          ><app-icon name="plus" [size]="16" />Novo activo</a
        >
      }
      <app-filter-bar
        id="fa"
        label="activos fixos"
        placeholder="N.º, designação, série ou localização"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Activos fixos"
        tableId="acc-assets"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [exportable]="true"
        [exporting]="exporting()"
        [emptyText]="
          list.q() || list.activeFilters() ? 'Sem activos com estes filtros.' : 'Sem activos fixos.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
        (export)="export($event)"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ statusText(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Assets {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly limit = LIMIT;
  protected readonly statuses = Object.entries(ASSET_STATUS);
  protected readonly canManage = computed(() => this.deps.workspace.can('fixed_assets.manage'));
  protected readonly classes = signal<AssetClass[]>([]);
  protected readonly exporting = signal(false);
  protected readonly statusText = (s: AssetStatus) => ASSET_STATUS[s] ?? s;
  protected readonly tone = (s: AssetStatus) =>
    s === 'ACTIVE'
      ? 'bg-success-soft text-success-text'
      : s === 'DRAFT'
        ? 'bg-warning-soft text-warning-text'
        : 'bg-surface-2 text-fg';
  private readonly classNames = computed(() => new Map(this.classes().map((c) => [c.id, c.code])));
  protected readonly columns: Column<FixedAsset>[] = [
    { key: 'number', label: 'N.º', required: true, link: (r) => ['/contabilidade/activos', r.id] },
    { key: 'name', label: 'Designação' },
    {
      key: 'classId',
      label: 'Classe',
      hideOnMobile: true,
      value: (r) => this.classNames().get(r.classId) ?? '…',
    },
    {
      key: 'acquisitionDate',
      label: 'Aquisição',
      hideOnMobile: true,
      value: (r) => formatDate(r.acquisitionDate),
    },
    { key: 'cost', label: 'Custo', align: 'end', value: (r) => moneyText(r.cost) },
    {
      key: 'accumulated',
      label: 'Depreciação acumulada',
      align: 'end',
      hideOnMobile: true,
      value: (r) => moneyText(r.accumulated),
    },
    {
      key: 'bookValue',
      label: 'Valor líquido',
      align: 'end',
      value: (r) => moneyText(r.bookValue),
    },
    { key: 'location', label: 'Localização', hideOnMobile: true, value: (r) => r.location ?? '—' },
    { key: 'status', label: 'Estado' },
  ];
  protected readonly list = new ListState<FixedAsset>(this.deps.api, {
    url: 'accounting/fixed-assets',
    filterKeys: ['status', 'classId'],
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
      key: 'classId',
      label: 'Classe',
      options: this.classes().map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
    },
  ]);

  constructor() {
    this.deps.api.page<AssetClass>('accounting/fixed-asset-classes', { limit: 200 }).then(
      (p) => this.classes.set(p.items),
      () => undefined,
    );
  }

  protected async export(columns: Column<FixedAsset>[]) {
    this.exporting.set(true);
    try {
      const n = await exportList(
        this.deps.api,
        'accounting/fixed-assets',
        withoutPaging(this.list.query()),
        columns,
        'activos-fixos.csv',
      );
      this.toasts.show(`Exportados ${n} activo(s).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
