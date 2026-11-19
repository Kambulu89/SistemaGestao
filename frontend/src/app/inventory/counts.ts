import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { COUNT_STATUS, type CountStatus, countTone, type StockCount } from './count-model';

interface Options {
  warehouses: { id: string; code: string; name: string }[];
}

/** Contagens físicas (8.7): plano, snapshot, contagem (cega), revisão das diferenças e aprovação do ajuste. */
@Component({
  selector: 'app-counts',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Contagens e ajustes"
      subtitle="Plano → snapshot do sistema → contagem (cega) e recontagem → diferenças justificadas → aprovação, que lança o ajuste."
      feature="inventory"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/inventario/contagens/nova" data-testid="ct-new"
          ><app-icon name="plus" [size]="16" />Nova contagem</a
        >
      }
      <app-filter-bar
        id="cts"
        label="contagens"
        placeholder="Número ou descrição"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Contagens"
        tableId="inv-counts"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters() ? 'Sem contagens com estes filtros.' : 'Sem contagens.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ label(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Counts {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly tone = countTone;
  protected readonly canManage = computed(() => this.workspace.canAny('inventory.counts.manage'));
  private readonly options = signal<Options>({ warehouses: [] });
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(COUNT_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'warehouseId',
      label: 'Armazém',
      options: this.options().warehouses.map((w) => ({
        value: w.id,
        label: `${w.code} — ${w.name}`,
      })),
    },
  ]);
  protected readonly columns: Column<StockCount>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (c) => c.number ?? 'Plano',
      link: (c) => ['/inventario/contagens', c.id],
    },
    { key: 'description', label: 'Descrição' },
    { key: 'warehouse', label: 'Armazém', value: (c) => c.warehouse.code },
    { key: 'zone', label: 'Zona', hideOnMobile: true, value: (c) => c.zone ?? 'Todo o armazém' },
    { key: 'blind', label: 'Cega', hideOnMobile: true, value: (c) => (c.blind ? 'Sim' : 'Não') },
    {
      key: 'progress',
      label: 'Contadas',
      hideOnMobile: true,
      value: (c) => (c.lineCount ? `${c.countedCount}/${c.lineCount}` : '—'),
    },
    {
      key: 'plannedDate',
      label: 'Prevista',
      hideOnMobile: true,
      value: (c) => (c.plannedDate ? formatDate(c.plannedDate) : '—'),
    },
    { key: 'status', label: 'Estado', value: (c) => COUNT_STATUS[c.status] },
  ];
  protected readonly list = new ListState<StockCount>(this.api, {
    url: 'inventory/counts',
    filterKeys: ['status', 'warehouseId'],
    sortFields: [],
    limit: 25,
  });

  constructor() {
    this.api.get<Options>('inventory/counts/options').then(
      (o) => this.options.set(o),
      () => undefined,
    );
  }

  protected label(s: CountStatus) {
    return COUNT_STATUS[s];
  }
}
