import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import {
  PROPOSAL_STATUS,
  type Proposal,
  type ProposalStatus,
  proposalTone,
} from './compensation-model';

/** Propostas de compensação no âmbito do membro, com a vista "a aprovar por mim". */
@Component({
  selector: 'app-compensation-proposals',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Compensação"
      subtitle="Propostas de alteração de subsídios, prémios, abonos e descontos. As novas fazem-se na ficha do colaborador."
      permission="hr.compensation.read"
      feature="hr"
      [anyScope]="true"
    >
      <app-filter-bar
        id="cp"
        label="propostas"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Propostas de compensação"
        tableId="hr-compensation"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.activeFilters() ? 'Sem propostas com estes filtros.' : 'Ainda não há propostas.'
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
export class CompensationProposals {
  private readonly api = inject(Api);
  protected readonly tone = proposalTone;
  protected readonly status = (s: ProposalStatus) => PROPOSAL_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    { key: 'view', label: 'Vista', options: [{ value: 'toApprove', label: 'A aprovar por mim' }] },
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(PROPOSAL_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<Proposal>[] = [
    {
      key: 'employee',
      label: 'Colaborador',
      required: true,
      value: (p) => p.employee.fullName,
      link: (p) => ['/rh/compensacao', p.id],
    },
    { key: 'effectiveDate', label: 'Efeito', value: (p) => formatDate(p.effectiveDate) },
    { key: 'reason', label: 'Motivo', hideOnMobile: true },
    { key: 'lines', label: 'Componentes', align: 'end', value: (p) => p.lines.length },
    { key: 'status', label: 'Estado', value: (p) => this.status(p.status) },
  ];
  protected readonly list = new ListState<Proposal>(this.api, {
    url: 'hr/compensation/proposals',
    filterKeys: ['view', 'status'],
    sortFields: [],
    limit: 25,
    transform: (q) => {
      const { view, ...rest } = q as Record<string, unknown>;
      return { ...rest, ...(view === 'toApprove' ? { toApprove: true } : {}) } as never;
    },
  });
}
