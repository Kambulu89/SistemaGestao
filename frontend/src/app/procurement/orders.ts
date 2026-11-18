import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import {
  APPROVAL_STATUS,
  approvalTone,
  INVOICE_STATUS,
  type OrderRow,
  progressTone,
  RECEIPT_STATUS,
} from './order-model';

/** Ordens de compra das entidades do âmbito, com os três estados (aprovação, recepção, facturação) lado a lado. */
@Component({
  selector: 'app-purchase-orders',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Ordens de compra"
      subtitle="Encomendas a fornecedores: aprovação por etapas, emissão numerada, recepção e facturação acompanhadas em separado."
      feature="procurement"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/compras/ordens/nova" data-testid="po-new"
          ><app-icon name="plus" [size]="16" />Nova ordem</a
        >
      }
      <app-filter-bar
        id="po"
        label="ordens de compra"
        placeholder="Número ou fornecedor"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Ordens de compra"
        tableId="proc-orders"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem ordens com estes filtros.'
            : 'Ainda não há ordens de compra.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="approvalStatus" let-row>
          <span class="badge" [class]="aTone(row.approvalStatus)" data-testid="po-approval">{{
            aLabel(row.approvalStatus)
          }}</span>
        </ng-template>
        <ng-template appCell="receiptStatus" let-row>
          <span class="badge" [class]="pTone(row.receiptStatus)">{{
            rLabel(row.receiptStatus)
          }}</span>
        </ng-template>
        <ng-template appCell="invoiceStatus" let-row>
          <span class="badge" [class]="pTone(row.invoiceStatus)">{{
            iLabel(row.invoiceStatus)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class PurchaseOrders {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.canAny('procurement.orders.manage'));
  protected readonly aTone = approvalTone;
  protected readonly pTone = progressTone;
  protected readonly aLabel = (s: OrderRow['approvalStatus']) => APPROVAL_STATUS[s];
  protected readonly rLabel = (s: OrderRow['receiptStatus']) => RECEIPT_STATUS[s];
  protected readonly iLabel = (s: OrderRow['invoiceStatus']) => INVOICE_STATUS[s];
  protected readonly filters: FilterDef[] = [
    {
      key: 'approvalStatus',
      label: 'Aprovação',
      options: Object.entries(APPROVAL_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'receiptStatus',
      label: 'Recepção',
      options: Object.entries(RECEIPT_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'invoiceStatus',
      label: 'Facturação',
      options: Object.entries(INVOICE_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'awaitingMe',
      label: 'Decisão',
      options: [{ value: 'true', label: 'À espera da minha decisão' }],
    },
  ];
  protected readonly columns: Column<OrderRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (r) =>
        r.number ? `${r.number}${r.revision ? ' (rev. ' + r.revision + ')' : ''}` : 'Rascunho',
      link: (r) => ['/compras/ordens', r.id],
    },
    {
      key: 'supplier',
      label: 'Fornecedor',
      value: (r) => `${r.supplier.code} — ${r.supplier.name}`,
    },
    {
      key: 'legalEntity',
      label: 'Entidade',
      hideOnMobile: true,
      hiddenByDefault: true,
      value: (r) => r.legalEntity.code,
    },
    { key: 'orderDate', label: 'Data', hideOnMobile: true, value: (r) => formatDate(r.orderDate) },
    {
      key: 'expectedDate',
      label: 'Entrega',
      hideOnMobile: true,
      value: (r) => formatDate(r.expectedDate),
    },
    {
      key: 'totalAmount',
      label: 'Total',
      align: 'end',
      value: (r) => money(r.totalAmount, r.currency),
    },
    { key: 'approvalStatus', label: 'Aprovação', value: (r) => this.aLabel(r.approvalStatus) },
    {
      key: 'receiptStatus',
      label: 'Recepção',
      hideOnMobile: true,
      value: (r) => this.rLabel(r.receiptStatus),
    },
    {
      key: 'invoiceStatus',
      label: 'Facturação',
      hideOnMobile: true,
      value: (r) => this.iLabel(r.invoiceStatus),
    },
  ];
  protected readonly list = new ListState<OrderRow>(this.api, {
    url: 'procurement/orders',
    filterKeys: ['approvalStatus', 'receiptStatus', 'invoiceStatus', 'awaitingMe'],
    sortFields: [],
    limit: 25,
  });
}
