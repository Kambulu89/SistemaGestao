import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import { PAYABLE_STATUS, type PayableRow, type PayableStatus, payableTone } from './finance-model';

/** Obrigações a pagar das facturas de fornecedor validadas (uma por factura), por vencimento. */
@Component({
  selector: 'app-payables',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Obrigações a pagar"
      subtitle="Uma por factura validada, abatida pelas notas de crédito; pagamentos registados pela tesouraria."
      feature="procurement"
    >
      <app-filter-bar
        id="py"
        label="obrigações"
        placeholder="Factura, número do fornecedor ou fornecedor"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Obrigações a pagar"
        tableId="proc-payables"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem obrigações com estes filtros.'
            : 'Ainda não há obrigações: nascem da validação das facturas.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row)" data-testid="py-status">{{ label(row) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Payables {
  private readonly api = inject(Api);
  protected readonly tone = (r: PayableRow) => payableTone(r.status, r.overdue);
  protected readonly label = (r: PayableRow) =>
    r.overdue ? 'Em atraso' : (PAYABLE_STATUS[r.status as PayableStatus] ?? r.status);
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(PAYABLE_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'overdue',
      label: 'Vencimento',
      options: [{ value: 'true', label: 'Em atraso' }],
    },
  ];
  protected readonly columns: Column<PayableRow>[] = [
    {
      key: 'invoice',
      label: 'Factura',
      required: true,
      value: (r) => `${r.invoice.number} (${r.invoice.invoiceNumber})`,
      link: (r) => ['/compras/obrigacoes', r.id],
    },
    {
      key: 'supplier',
      label: 'Fornecedor',
      hideOnMobile: true,
      value: (r) => `${r.supplier.code} — ${r.supplier.name}`,
    },
    { key: 'dueDate', label: 'Vencimento', value: (r) => formatDate(r.dueDate) },
    {
      key: 'amount',
      label: 'Valor',
      align: 'end',
      hideOnMobile: true,
      value: (r) => money(r.amount, r.currency),
    },
    { key: 'balance', label: 'Saldo', align: 'end', value: (r) => money(r.balance, r.currency) },
    { key: 'status', label: 'Estado', value: (r) => this.label(r) },
  ];
  protected readonly list = new ListState<PayableRow>(this.api, {
    url: 'procurement/payables',
    filterKeys: ['status', 'overdue'],
    sortFields: [],
    limit: 25,
  });
}
