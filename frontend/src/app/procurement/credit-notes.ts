import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import {
  CREDIT_NOTE_STATUS,
  type CreditNoteRow,
  type CreditNoteStatus,
  creditNoteTone,
} from './credit-note-model';

/** Notas de crédito de fornecedor das entidades do âmbito (registam-se a partir da factura ou da devolução). */
@Component({
  selector: 'app-credit-notes',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Notas de crédito de fornecedor"
      subtitle="Correcções das facturas validadas: quantidades devolvidas ao preço da factura e ajustes de valor."
      feature="procurement"
    >
      <app-filter-bar
        id="nc"
        label="notas de crédito"
        placeholder="Número, nota do fornecedor, factura ou fornecedor"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Notas de crédito de fornecedor"
        tableId="proc-credit-notes"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem notas de crédito com estes filtros.'
            : 'Ainda não há notas de crédito. Registam-se a partir de uma factura validada.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="nc-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class CreditNotes {
  private readonly api = inject(Api);
  protected readonly tone = creditNoteTone;
  protected readonly status = (s: CreditNoteStatus) => CREDIT_NOTE_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(CREDIT_NOTE_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<CreditNoteRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (r) => r.number ?? 'Rascunho',
      link: (r) => ['/compras/notas-credito', r.id],
    },
    { key: 'creditNoteNumber', label: 'Nota do fornecedor', value: (r) => r.creditNoteNumber },
    {
      key: 'supplier',
      label: 'Fornecedor',
      hideOnMobile: true,
      value: (r) => `${r.supplier.code} — ${r.supplier.name}`,
    },
    {
      key: 'invoice',
      label: 'Factura',
      hideOnMobile: true,
      value: (r) => `${r.invoice.number} (${r.invoice.invoiceNumber})`,
    },
    {
      key: 'creditNoteDate',
      label: 'Data',
      hiddenByDefault: true,
      value: (r) => formatDate(r.creditNoteDate),
    },
    {
      key: 'totalAmount',
      label: 'Total',
      align: 'end',
      value: (r) => money(r.totalAmount, r.currency),
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<CreditNoteRow>(this.api, {
    url: 'procurement/credit-notes',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });
}
