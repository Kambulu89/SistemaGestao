import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import {
  APPROVAL_STATUS,
  DELIVERY_STATUS,
  INVOICING_STATUS,
  ORDER_STATUS,
  type OrderRow,
  type OrderStatus,
  orderTone,
  subTone,
} from './order-model';

/** Encomendas de venda com os estados de aprovação, reserva, entrega e facturação separados. */
@Component({
  selector: 'app-orders',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Encomendas de venda"
      subtitle="Confirmação com limite de crédito, reserva e expedição pelo inventário, serviços prestados."
      feature="sales"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/vendas/encomendas/nova" data-testid="so-new"
          ><app-icon name="plus" [size]="16" />Nova encomenda</a
        >
      }
      <app-filter-bar
        id="so"
        label="encomendas"
        placeholder="Número ou cliente"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Encomendas de venda"
        tableId="sales-orders"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem encomendas com estes filtros.'
            : 'Ainda não há encomendas.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="so-status">{{
            status(row.status)
          }}</span>
        </ng-template>
        <ng-template appCell="delivery" let-row>
          <span class="badge" [class]="sub(row.deliveryStatus)">{{
            delivery(row.deliveryStatus)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Orders {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.canAny('sales.orders.manage'));
  protected readonly tone = orderTone;
  protected readonly sub = subTone;
  protected readonly status = (s: OrderStatus) => ORDER_STATUS[s] ?? s;
  protected readonly delivery = (s: string) => DELIVERY_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(ORDER_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'approvalStatus',
      label: 'Aprovação',
      options: Object.entries(APPROVAL_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'deliveryStatus',
      label: 'Entrega',
      options: Object.entries(DELIVERY_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<OrderRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      link: (r) => ['/vendas/encomendas', r.id],
      value: (r) => r.number ?? 'Rascunho',
    },
    { key: 'customer', label: 'Cliente', value: (r) => `${r.customer.code} — ${r.customer.name}` },
    { key: 'orderDate', label: 'Data', hideOnMobile: true },
    {
      key: 'grossTotal',
      label: 'Total',
      align: 'end',
      value: (r) => money(r.grossTotal, r.currency),
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
    {
      key: 'approval',
      label: 'Aprovação',
      hideOnMobile: true,
      value: (r) => APPROVAL_STATUS[r.approvalStatus],
    },
    {
      key: 'delivery',
      label: 'Entrega',
      hideOnMobile: true,
      value: (r) => DELIVERY_STATUS[r.deliveryStatus],
    },
    {
      key: 'invoicing',
      label: 'Facturação',
      hiddenByDefault: true,
      value: (r) => INVOICING_STATUS[r.invoicingStatus],
    },
  ];
  protected readonly list = new ListState<OrderRow>(this.api, {
    url: 'sales/orders',
    filterKeys: ['status', 'approvalStatus', 'deliveryStatus'],
    sortFields: [],
    limit: 25,
  });
}
