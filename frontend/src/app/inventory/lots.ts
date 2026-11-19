import { Component, computed } from '@angular/core';
import { inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { LOT_STATUS, type LotRow, lotStatusLabel, lotTone } from './lot-model';
import { qty } from './stock-model';

/** Lotes (8.8): validade, estado e stock; daqui abre-se a rastreabilidade, o bloqueio e a recolha. */
@Component({
  selector: 'app-lots',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Lotes"
      subtitle="Por ordem de validade (FEFO: o primeiro a expirar é o primeiro a sair). Bloquear ou recolher passa o stock livre do lote a bloqueado."
      permission="inventory.read"
      feature="inventory"
      [anyScope]="true"
    >
      <app-filter-bar
        id="lots"
        label="lotes"
        placeholder="Lote, SKU ou produto"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Lotes"
        tableId="inv-lots"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters() ? 'Sem lotes com estes filtros.' : 'Sem lotes.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row)">{{ statusLabel(row) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Lots {
  private readonly api = inject(Api);
  protected readonly tone = lotTone;
  protected readonly statusLabel = lotStatusLabel;
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(LOT_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'expiringWithinDays',
      label: 'Validade',
      options: [
        { value: '0', label: 'Expirados' },
        { value: '30', label: 'Expiram em 30 dias' },
        { value: '90', label: 'Expiram em 90 dias' },
      ],
    },
    {
      key: 'withStock',
      label: 'Stock',
      options: [{ value: 'true', label: 'Só com stock' }],
    },
  ]);
  protected readonly columns: Column<LotRow>[] = [
    {
      key: 'code',
      label: 'Lote',
      required: true,
      link: (l) => ['/inventario/lotes', l.id],
    },
    {
      key: 'product',
      label: 'Produto',
      value: (l) => (l.variant ? l.variant.sku : l.product.sku),
    },
    { key: 'name', label: 'Nome', hideOnMobile: true, value: (l) => l.product.name },
    {
      key: 'expiryDate',
      label: 'Validade',
      value: (l) => (l.expiryDate ? formatDate(l.expiryDate) : '—'),
    },
    {
      key: 'stock',
      label: 'Stock',
      align: 'end',
      value: (l) => `${qty(l.stock ?? '0')} ${l.uom}`,
    },
    { key: 'status', label: 'Estado', value: (l) => lotStatusLabel(l) },
  ];
  protected readonly list = new ListState<LotRow>(this.api, {
    url: 'inventory/lots',
    filterKeys: ['status', 'expiringWithinDays', 'withStock', 'productId'],
    sortFields: [],
    limit: 25,
  });
}
