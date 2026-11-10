import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { type Column, DataTable } from '../ui/data-table';
import { FilterBar } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import type { SerialRow } from './lot-model';
import { BUCKET } from './stock-model';

/** Números de série (8.8): onde está cada unidade (ou se já saiu) e, no detalhe, todo o seu percurso. */
@Component({
  selector: 'app-serials',
  imports: [EntityListPage, FilterBar, DataTable],
  template: `
    <app-entity-list-page
      title="Números de série"
      subtitle="Cada unidade com série: onde está agora e, no detalhe, por onde passou."
      permission="inventory.read"
      feature="inventory"
      [anyScope]="true"
    >
      <app-filter-bar
        id="srl"
        label="séries"
        placeholder="Série ou SKU"
        [state]="list"
        [filters]="[]"
      />
      <app-data-table
        label="Números de série"
        tableId="inv-serials"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="list.q() ? 'Sem séries com esta pesquisa.' : 'Sem séries registadas.'"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      />
    </app-entity-list-page>
  `,
})
export class Serials {
  private readonly api = inject(Api);
  protected readonly columns: Column<SerialRow>[] = [
    { key: 'serial', label: 'Série', required: true, link: (s) => ['/inventario/series', s.id] },
    { key: 'product', label: 'Produto', value: (s) => s.product.sku },
    { key: 'name', label: 'Nome', hideOnMobile: true, value: (s) => s.product.name },
    {
      key: 'lot',
      label: 'Lote',
      hideOnMobile: true,
      value: (s) => s.lot?.code ?? '—',
      link: (s) => (s.lot ? ['/inventario/lotes', s.lot.id] : null),
    },
    {
      key: 'where',
      label: 'Onde está',
      value: (s) =>
        s.status === 'OUT'
          ? 'Fora do stock'
          : s.warehouse
            ? `${s.warehouse}${s.location ? ' · ' + s.location : ''} · ${BUCKET[s.bucket as keyof typeof BUCKET] ?? s.bucket}`
            : 'Noutro armazém',
    },
  ];
  protected readonly list = new ListState<SerialRow>(this.api, {
    url: 'inventory/serials',
    filterKeys: ['productId'],
    sortFields: [],
    limit: 25,
  });
}
