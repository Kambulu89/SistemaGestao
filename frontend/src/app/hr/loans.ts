import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { formatMoney } from '../ui/money-input';
import { EntityListPage } from '../ui/templates';
import {
  LOAN_KIND,
  LOAN_STATUS,
  type Loan,
  type LoanKind,
  type LoanStatus,
  loanTone,
  periodLabel,
} from './loans-model';

/** Adiantamentos e empréstimos no âmbito do membro, com a vista "a aprovar por mim". */
@Component({
  selector: 'app-loans',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Adiantamentos e empréstimos"
      subtitle="Pedidos, planos de prestações e saldos. Os novos fazem-se na ficha do colaborador."
      permission="hr.loans.read"
      feature="hr"
      [anyScope]="true"
    >
      <app-filter-bar
        id="ln"
        label="pedidos"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Adiantamentos e empréstimos"
        tableId="hr-loans"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.activeFilters() ? 'Sem pedidos com estes filtros.' : 'Ainda não há pedidos.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ status(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Loans {
  private readonly api = inject(Api);
  protected readonly tone = loanTone;
  protected readonly status = (s: LoanStatus) => LOAN_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    { key: 'view', label: 'Vista', options: [{ value: 'toApprove', label: 'A aprovar por mim' }] },
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(LOAN_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'kind',
      label: 'Tipo',
      options: Object.entries(LOAN_KIND).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<Loan>[] = [
    { key: 'code', label: 'Código', required: true, link: (l) => ['/rh/emprestimos', l.id] },
    { key: 'employee', label: 'Colaborador', value: (l) => l.employee.fullName },
    { key: 'kind', label: 'Tipo', value: (l) => LOAN_KIND[l.kind as LoanKind] },
    {
      key: 'principal',
      label: 'Montante',
      align: 'end',
      value: (l) => `${formatMoney(l.principal)} ${l.currency}`,
    },
    {
      key: 'outstandingAmount',
      label: 'Em dívida',
      align: 'end',
      hideOnMobile: true,
      value: (l) => formatMoney(l.outstandingAmount),
    },
    {
      key: 'firstPeriod',
      label: 'Primeiro desconto',
      hideOnMobile: true,
      value: (l) => periodLabel(l.firstPeriod),
    },
    { key: 'status', label: 'Estado', value: (l) => this.status(l.status) },
  ];
  protected readonly list = new ListState<Loan>(this.api, {
    url: 'hr/loans',
    filterKeys: ['view', 'status', 'kind'],
    sortFields: [],
    limit: 25,
    transform: (q) => {
      const { view, ...rest } = q as Record<string, unknown>;
      return { ...rest, ...(view === 'toApprove' ? { toApprove: true } : {}) } as never;
    },
  });
}
