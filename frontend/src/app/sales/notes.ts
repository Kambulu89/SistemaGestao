import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import { NOTE_KIND, NOTE_REASON, NOTE_STATUS, type NoteRow, noteTone } from './note-model';

/** Notas de crédito e débito: correcções fiscais de facturas emitidas (criam-se a partir da factura). */
@Component({
  selector: 'app-notes',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Notas de crédito e débito"
      subtitle="Correcções de facturas emitidas. Criam-se a partir da factura original."
      feature="sales"
    >
      <app-filter-bar
        id="nt"
        label="notas"
        placeholder="Número, factura ou cliente"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Notas"
        tableId="sales-notes"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem notas com estes filtros.'
            : 'Ainda não há notas. Crie-as a partir de uma factura emitida.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="nt-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Notes {
  private readonly api = inject(Api);
  protected readonly tone = noteTone;
  protected readonly status = (s: string) => NOTE_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'kind',
      label: 'Tipo',
      options: Object.entries(NOTE_KIND).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(NOTE_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'credit',
      label: 'Crédito',
      options: [{ value: 'true', label: 'Com crédito disponível' }],
    },
  ];
  protected readonly columns: Column<NoteRow>[] = [
    {
      key: 'number',
      label: 'Documento',
      required: true,
      link: (r) => ['/vendas/notas', r.id],
      value: (r) => r.number ?? `${NOTE_KIND[r.kind]} (rascunho)`,
    },
    { key: 'kind', label: 'Tipo', hideOnMobile: true, value: (r) => NOTE_KIND[r.kind] },
    { key: 'invoice', label: 'Factura', value: (r) => r.invoiceNumber },
    {
      key: 'customer',
      label: 'Cliente',
      hideOnMobile: true,
      value: (r) => `${r.customer.code} — ${r.customer.name}`,
    },
    { key: 'noteDate', label: 'Data', hideOnMobile: true },
    {
      key: 'reason',
      label: 'Motivo',
      hiddenByDefault: true,
      value: (r) => NOTE_REASON[r.reasonCode] ?? r.reasonCode,
    },
    {
      key: 'total',
      label: 'Valor',
      align: 'end',
      value: (r) => money(r.payableTotal, r.currency),
    },
    {
      key: 'credit',
      label: 'Crédito livre',
      align: 'end',
      hiddenByDefault: true,
      value: (r) => (r.availableCredit === null ? '—' : money(r.availableCredit, r.currency)),
    },
    { key: 'status', label: 'Estado', value: (r) => NOTE_STATUS[r.status] },
  ];
  protected readonly list = new ListState<NoteRow>(this.api, {
    url: 'sales/notes',
    filterKeys: ['kind', 'status', 'credit'],
    sortFields: [],
    limit: 25,
  });
}
