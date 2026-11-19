import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { type Warehouse, WAREHOUSE_TYPE, warehouseTone } from './warehouse-model';

/** Armazéns no âmbito do membro (os restritos só para quem os gere ou está na lista). */
@Component({
  selector: 'app-warehouses',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Armazéns"
      subtitle="Armazéns por entidade legal e filial, com localizações e acesso por armazém."
      permission="inventory.read"
      feature="inventory"
      [anyScope]="true"
    >
      @if (canCreate()) {
        <a actions class="btn-primary" routerLink="/inventario/armazens/novo"
          ><app-icon name="plus" [size]="16" />Novo armazém</a
        >
      }
      <app-filter-bar
        id="whs"
        label="armazéns"
        placeholder="Código ou nome"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Armazéns"
        tableId="inv-warehouses"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem armazéns com estes filtros.'
            : 'Sem armazéns no seu âmbito.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{
            row.status === 'ACTIVE' ? 'Activo' : 'Inactivo'
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Warehouses {
  private readonly api = inject(Api);
  protected readonly tone = warehouseTone;
  private readonly meta = signal<{ canCreate?: boolean }>({});
  protected readonly canCreate = computed(() => !!this.meta().canCreate);
  protected readonly filters: FilterDef[] = [
    {
      key: 'warehouseType',
      label: 'Tipo',
      options: Object.entries(WAREHOUSE_TYPE).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'status',
      label: 'Estado',
      options: [
        { value: 'ACTIVE', label: 'Activo' },
        { value: 'INACTIVE', label: 'Inactivo' },
      ],
    },
  ];
  protected readonly columns: Column<Warehouse>[] = [
    { key: 'code', label: 'Código', required: true, link: (w) => ['/inventario/armazens', w.id] },
    { key: 'name', label: 'Nome' },
    {
      key: 'warehouseType',
      label: 'Tipo',
      value: (w) => WAREHOUSE_TYPE[w.warehouseType] ?? w.warehouseType,
    },
    { key: 'legalEntity', label: 'Entidade', hideOnMobile: true, value: (w) => w.legalEntity.code },
    { key: 'branch', label: 'Filial', hideOnMobile: true, value: (w) => w.branch?.name ?? null },
    {
      key: 'accessMode',
      label: 'Acesso',
      hideOnMobile: true,
      value: (w) => (w.accessMode === 'OPEN' ? 'Aberto' : 'Restrito'),
    },
    {
      key: 'status',
      label: 'Estado',
      value: (w) => (w.status === 'ACTIVE' ? 'Activo' : 'Inactivo'),
    },
  ];
  protected readonly list = new ListState<Warehouse>(this.api, {
    url: 'inventory/warehouses',
    filterKeys: ['warehouseType', 'status'],
    sortFields: [],
    limit: 25,
  });

  constructor() {
    this.api.getWithMeta<Warehouse[]>('inventory/warehouses', { limit: 1 }).then(
      (r) => this.meta.set(r.meta as { canCreate?: boolean }),
      () => undefined,
    );
  }
}
