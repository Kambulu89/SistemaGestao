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
  COLLECTION_STATE,
  FISCAL_STATE,
  INVOICE_STATUS,
  type InvoiceRow,
  invoiceTone,
} from './invoice-model';

/** Facturas de venda: estados de negócio, fiscal e de cobrança distintos. Emissão demonstrativa (simulação). */
@Component({
  selector: 'app-invoices',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Facturas de venda"
      subtitle="Emissão demonstrativa: séries fiscais em simulação, sem comunicação com a AGT."
      feature="sales"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/vendas/facturas/nova" data-testid="iv-new"
          ><app-icon name="plus" [size]="16" />Nova factura de serviços</a
        >
      }
      <app-filter-bar
        id="iv"
        label="facturas"
        placeholder="Número ou cliente"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Facturas de venda"
        tableId="sales-invoices"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem facturas com estes filtros.'
            : 'Ainda não há facturas.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="iv-status">{{
            status(row.status)
          }}</span>
        </ng-template>
        <ng-template appCell="collection" let-row>
          @if (row.collectionStatus) {
            <span class="badge" [class]="tone(row.collectionStatus)">{{
              collection(row.collectionStatus)
            }}</span>
          }
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Invoices {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.canAny('sales.invoices.manage'));
  protected readonly tone = invoiceTone;
  protected readonly status = (s: string) => INVOICE_STATUS[s] ?? s;
  protected readonly collection = (s: string) => COLLECTION_STATE[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(INVOICE_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'collection',
      label: 'Cobrança',
      options: Object.entries(COLLECTION_STATE).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'fiscalStatus',
      label: 'Fiscal',
      options: Object.entries(FISCAL_STATE).map(([value, label]) => ({
        value,
        label: label.replace('Fiscal: ', ''),
      })),
    },
  ];
  protected readonly columns: Column<InvoiceRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      link: (r) => ['/vendas/facturas', r.id],
      value: (r) => r.number ?? 'Rascunho',
    },
    { key: 'customer', label: 'Cliente', value: (r) => `${r.customer.code} — ${r.customer.name}` },
    { key: 'invoiceDate', label: 'Data', hideOnMobile: true },
    { key: 'dueDate', label: 'Vencimento', hideOnMobile: true, value: (r) => r.dueDate ?? '—' },
    {
      key: 'payableTotal',
      label: 'A pagar',
      align: 'end',
      value: (r) => money(r.payableTotal, r.currency),
    },
    { key: 'status', label: 'Estado', value: (r) => INVOICE_STATUS[r.status] },
    {
      key: 'collection',
      label: 'Cobrança',
      hideOnMobile: true,
      value: (r) => (r.collectionStatus ? COLLECTION_STATE[r.collectionStatus] : ''),
    },
    {
      key: 'fiscal',
      label: 'Fiscal',
      hiddenByDefault: true,
      value: (r) => (r.fiscalStatus ? FISCAL_STATE[r.fiscalStatus] : ''),
    },
  ];
  protected readonly list = new ListState<InvoiceRow>(this.api, {
    url: 'sales/invoices',
    filterKeys: ['status', 'collection', 'fiscalStatus'],
    sortFields: [],
    limit: 25,
  });
}
