import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { type Reservation, RESERVATION_SOURCE, reservationLink } from './requisition-model';
import { productLabel, qty } from './stock-model';
import type { Warehouse } from './warehouse-model';

/**
 * Reservas activas (8.6): quanto está reservado, onde e para quê. Derivadas dos movimentos — a soma coincide sempre com
 * a coluna "Reservado" dos saldos de stock.
 */
@Component({
  selector: 'app-reservations',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Reservas activas"
      subtitle="Stock prometido a requisições e transferências: reduz o disponível, não o físico."
      permission="inventory.read"
      feature="inventory"
      [anyScope]="true"
    >
      <app-filter-bar
        id="rsv"
        label="reservas"
        [searchable]="false"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Reservas activas"
        tableId="inv-reservations"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="'Sem stock reservado.'"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="source" let-row>
          @if (link(row); as l) {
            <a class="link" [routerLink]="l">{{ sourceText(row) }}</a>
          } @else {
            {{ sourceText(row) }}
          }
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Reservations {
  private readonly api = inject(Api);
  protected readonly link = reservationLink;
  private readonly warehouses = signal<Warehouse[]>([]);
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'warehouseId',
      label: 'Armazém',
      options: this.warehouses().map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
    },
    {
      key: 'sourceType',
      label: 'Origem',
      options: Object.entries(RESERVATION_SOURCE).map(([value, label]) => ({ value, label })),
    },
  ]);
  protected readonly columns: Column<Reservation>[] = [
    { key: 'source', label: 'Origem', required: true, value: (r) => this.sourceText(r) },
    {
      key: 'product',
      label: 'Produto',
      value: (r) => productLabel(r),
      link: (r) => ['/inventario/produtos', r.product.id],
    },
    { key: 'name', label: 'Nome', hideOnMobile: true, value: (r) => r.product.name },
    { key: 'warehouse', label: 'Armazém', value: (r) => r.warehouse.code },
    {
      key: 'quantity',
      label: 'Reservado',
      align: 'end',
      value: (r) => `${qty(r.quantity)} ${r.uom}`,
    },
    {
      key: 'lastAt',
      label: 'Último movimento',
      hideOnMobile: true,
      value: (r) => formatDateTime(r.lastAt),
    },
  ];
  protected readonly list = new ListState<Reservation>(this.api, {
    url: 'inventory/reservations',
    filterKeys: ['warehouseId', 'sourceType', 'productId'],
    sortFields: [],
    limit: 50,
  });

  constructor() {
    this.api.get<Warehouse[]>('inventory/warehouses', { limit: 200 }).then(
      (w) => this.warehouses.set(w),
      () => undefined,
    );
  }

  protected sourceText(r: Reservation) {
    const kind = RESERVATION_SOURCE[r.source.type] ?? r.source.type;
    return r.source.ref ? `${kind} ${r.source.ref}` : kind;
  }
}
