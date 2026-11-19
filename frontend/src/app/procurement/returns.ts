import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import {
  CREDIT_STATUS,
  type CreditStatus,
  creditTone,
  REMEDY,
  RETURN_REASON,
  RETURN_STATUS,
  type ReturnRow,
  type ReturnStatus,
  returnTone,
} from './return-model';

/** Devoluções a fornecedor e não conformidades das entidades do âmbito (registam-se a partir da recepção). */
@Component({
  selector: 'app-returns',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Devoluções a fornecedor"
      subtitle="Não conformidades das recepções: o que volta ao fornecedor, com evidências, e o crédito a receber."
      feature="procurement"
    >
      <app-filter-bar
        id="dv"
        label="devoluções"
        placeholder="Número, ordem, fornecedor ou descrição"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Devoluções a fornecedor"
        tableId="proc-returns"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem devoluções com estes filtros.'
            : 'Ainda não há devoluções. Registam-se a partir de uma recepção confirmada.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="dv-status">{{
            status(row.status)
          }}</span>
        </ng-template>
        <ng-template appCell="creditStatus" let-row>
          <span class="badge" [class]="ctone(row.creditStatus)">{{
            credit(row.creditStatus)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Returns {
  private readonly api = inject(Api);
  protected readonly tone = returnTone;
  protected readonly ctone = creditTone;
  protected readonly status = (s: ReturnStatus) => RETURN_STATUS[s] ?? s;
  protected readonly credit = (s: CreditStatus) => CREDIT_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(RETURN_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'creditStatus',
      label: 'Crédito',
      options: Object.entries(CREDIT_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<ReturnRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (r) => r.number ?? 'Rascunho',
      link: (r) => ['/compras/devolucoes', r.id],
    },
    { key: 'receipt', label: 'Recepção', value: (r) => r.receipt.number },
    {
      key: 'supplier',
      label: 'Fornecedor',
      hideOnMobile: true,
      value: (r) => `${r.supplier.code} — ${r.supplier.name}`,
    },
    {
      key: 'reasonCode',
      label: 'Motivo',
      hideOnMobile: true,
      value: (r) => RETURN_REASON[r.reasonCode] ?? r.reasonCode,
    },
    { key: 'remedy', label: 'Solução', hideOnMobile: true, value: (r) => REMEDY[r.remedy] },
    {
      key: 'returnDate',
      label: 'Data',
      hiddenByDefault: true,
      value: (r) => formatDate(r.returnDate),
    },
    { key: 'order', label: 'Ordem', hiddenByDefault: true, value: (r) => r.order.number },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
    {
      key: 'creditStatus',
      label: 'Crédito',
      hideOnMobile: true,
      value: (r) => this.credit(r.creditStatus),
    },
  ];
  protected readonly list = new ListState<ReturnRow>(this.api, {
    url: 'procurement/returns',
    filterKeys: ['status', 'creditStatus'],
    sortFields: [],
    limit: 25,
  });
}
