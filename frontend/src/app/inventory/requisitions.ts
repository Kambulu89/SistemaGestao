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
  type Requisition,
  REQUISITION_STATUS,
  type RequisitionStatus,
  requisitionTone,
} from './requisition-model';

interface Options {
  warehouses: { id: string; code: string; name: string }[];
  departments: { id: string; code: string; name: string }[];
}

/** Requisições internas (8.6): pedidos dos departamentos ao armazém, com aprovação, reserva e entrega. */
@Component({
  selector: 'app-requisitions',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Requisições internas"
      subtitle="Pedido do departamento → aprovação (reserva: baixa o disponível, não o físico) → separação → entrega (consumo) ou libertação."
      feature="inventory"
    >
      @if (canRequest()) {
        <a
          actions
          class="btn-primary"
          routerLink="/inventario/requisicoes/nova"
          data-testid="rq-new"
          ><app-icon name="plus" [size]="16" />Nova requisição</a
        >
      }
      <app-filter-bar
        id="rqs"
        label="requisições"
        placeholder="Número ou finalidade"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Requisições internas"
        tableId="inv-requisitions"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem requisições com estes filtros.'
            : 'Sem requisições.'
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
export class Requisitions {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly tone = requisitionTone;
  protected readonly canRequest = computed(() =>
    this.workspace.canAny('inventory.requisitions.request'),
  );
  private readonly options = signal<Options>({ warehouses: [], departments: [] });
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(REQUISITION_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'warehouseId',
      label: 'Armazém',
      options: this.options().warehouses.map((w) => ({
        value: w.id,
        label: `${w.code} — ${w.name}`,
      })),
    },
    {
      key: 'departmentId',
      label: 'Departamento',
      options: this.options().departments.map((d) => ({
        value: d.id,
        label: `${d.code} — ${d.name}`,
      })),
    },
  ]);
  protected readonly columns: Column<Requisition>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (r) => r.number ?? 'Por aprovar',
      link: (r) => ['/inventario/requisicoes', r.id],
    },
    { key: 'department', label: 'Departamento', value: (r) => r.department.code },
    { key: 'warehouse', label: 'Armazém', value: (r) => r.warehouse.code },
    { key: 'purpose', label: 'Finalidade', hideOnMobile: true },
    {
      key: 'requestedBy',
      label: 'Pedida por',
      hideOnMobile: true,
      value: (r) => r.requestedBy.name,
    },
    {
      key: 'neededBy',
      label: 'Precisa em',
      hideOnMobile: true,
      value: (r) => (r.neededBy ? formatDate(r.neededBy) : '—'),
    },
    { key: 'status', label: 'Estado', value: (r) => REQUISITION_STATUS[r.status] },
  ];
  protected readonly list = new ListState<Requisition>(this.api, {
    url: 'inventory/requisitions',
    filterKeys: ['status', 'warehouseId', 'departmentId'],
    sortFields: [],
    limit: 25,
  });

  constructor() {
    this.api.get<Options>('inventory/requisitions/options').then(
      (o) => this.options.set(o),
      () => undefined,
    );
  }

  protected label(s: RequisitionStatus) {
    return REQUISITION_STATUS[s];
  }
}
