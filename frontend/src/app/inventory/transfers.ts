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
import {
  type Transfer,
  TRANSFER_STATUS,
  type TransferStatus,
  transferTone,
} from './transfer-model';
import type { Warehouse } from './warehouse-model';

/** Transferências entre armazéns (8.5), incluindo entre entidades legais (intragrupo). */
@Component({
  selector: 'app-transfers',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Transferências"
      subtitle="Pedido → aprovação (reserva na origem) → separação → expedição (em trânsito) → recepção no destino."
      permission="inventory.read"
      feature="inventory"
      [anyScope]="true"
    >
      @if (canManage()) {
        <a
          actions
          class="btn-primary"
          routerLink="/inventario/transferencias/nova"
          data-testid="trf-new"
          ><app-icon name="plus" [size]="16" />Nova transferência</a
        >
      }
      <app-filter-bar
        id="trfs"
        label="transferências"
        placeholder="Número ou referência intragrupo"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Transferências"
        tableId="inv-transfers"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem transferências com estes filtros.'
            : 'Sem transferências.'
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
export class Transfers {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly tone = transferTone;
  protected readonly canManage = computed(() =>
    this.workspace.canAny('inventory.transfers.manage'),
  );
  private readonly warehouses = signal<Warehouse[]>([]);
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(TRANSFER_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'warehouseId',
      label: 'Armazém',
      options: this.warehouses().map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
    },
  ]);
  protected readonly columns: Column<Transfer>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (t) => t.number ?? 'Por aprovar',
      link: (t) => ['/inventario/transferencias', t.id],
    },
    { key: 'requestedDate', label: 'Data', value: (t) => formatDate(t.requestedDate) },
    { key: 'source', label: 'Origem', value: (t) => t.source.warehouse.code },
    { key: 'dest', label: 'Destino', value: (t) => t.dest.warehouse.code },
    {
      key: 'intercompany',
      label: 'Tipo',
      hideOnMobile: true,
      value: (t) => (t.intercompany ? 'Intragrupo' : 'Interna'),
    },
    { key: 'lineCount', label: 'Linhas', align: 'end', hideOnMobile: true },
    { key: 'status', label: 'Estado', value: (t) => TRANSFER_STATUS[t.status] },
  ];
  protected readonly list = new ListState<Transfer>(this.api, {
    url: 'inventory/transfers',
    filterKeys: ['status', 'warehouseId'],
    sortFields: [],
    limit: 25,
  });

  constructor() {
    this.api.get<Warehouse[]>('inventory/warehouses', { limit: 200 }).then(
      (w) => this.warehouses.set(w),
      () => undefined,
    );
  }

  protected label(s: TransferStatus) {
    return TRANSFER_STATUS[s];
  }
}
