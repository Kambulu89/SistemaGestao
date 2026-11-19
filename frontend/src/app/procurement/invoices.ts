import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import { INVOICE_STATUS, type InvoiceRow, type InvoiceStatus, invoiceTone } from './invoice-model';

/** Facturas de fornecedor das entidades do âmbito, com o estado da conferência a três. */
@Component({
  selector: 'app-invoices',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Facturas de fornecedor"
      subtitle="Conferidas com a ordem e o recebido; as divergências precisam de excepção autorizada por outra pessoa."
      feature="procurement"
    >
      <app-filter-bar
        id="fi"
        label="facturas"
        placeholder="Número, ordem ou fornecedor"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Facturas de fornecedor"
        tableId="proc-invoices"
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
          <span class="badge" [class]="tone(row.status)" data-testid="fi-status">{{
            status(row.status)
          }}</span>
          @if (row.divergences) {
            <span class="badge bg-warning-soft text-warning-text"
              >{{ row.divergences }} divergência(s)</span
            >
          }
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Invoices {
  private readonly api = inject(Api);
  protected readonly tone = invoiceTone;
  protected readonly status = (s: InvoiceStatus) => INVOICE_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(INVOICE_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'divergent',
      label: 'Conferência',
      options: [{ value: 'true', label: 'Com divergências' }],
    },
  ];
  protected readonly columns: Column<InvoiceRow>[] = [
    {
      key: 'invoiceNumber',
      label: 'Factura',
      required: true,
      link: (r) => ['/compras/facturas', r.id],
    },
    { key: 'number', label: 'Número interno', hideOnMobile: true, value: (r) => r.number ?? '—' },
    {
      key: 'supplier',
      label: 'Fornecedor',
      hideOnMobile: true,
      value: (r) => `${r.supplier.code} — ${r.supplier.name}`,
    },
    { key: 'order', label: 'Ordem', hideOnMobile: true, value: (r) => r.order.number },
    {
      key: 'invoiceDate',
      label: 'Data',
      hideOnMobile: true,
      value: (r) => formatDate(r.invoiceDate),
    },
    {
      key: 'dueDate',
      label: 'Vencimento',
      hiddenByDefault: true,
      value: (r) => formatDate(r.dueDate),
    },
    {
      key: 'totalAmount',
      label: 'Total',
      align: 'end',
      value: (r) => money(r.totalAmount, r.currency),
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<InvoiceRow>(this.api, {
    url: 'procurement/invoices',
    filterKeys: ['status', 'divergent'],
    sortFields: [],
    limit: 25,
  });
}
