import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import {
  CASE_CATEGORY,
  CASE_STATUS,
  type CaseStatus,
  caseTone,
  type DisciplinaryCase,
} from './training-model';

/** Processos disciplinares no âmbito (acesso restrito; nunca os próprios). Abrem-se na ficha do colaborador. */
@Component({
  selector: 'app-discipline-cases',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Processos disciplinares"
      subtitle="Acesso restrito e auditado. Os processos abrem-se na ficha do colaborador."
      permission="hr.discipline.read"
      feature="hr"
      [anyScope]="true"
    >
      <app-filter-bar
        id="dc"
        label="processos"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Processos disciplinares"
        tableId="hr-discipline"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.activeFilters() ? 'Sem processos com estes filtros.' : 'Sem processos no seu âmbito.'
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
export class DisciplineCases {
  private readonly api = inject(Api);
  protected readonly tone = caseTone;
  protected readonly status = (s: CaseStatus) => CASE_STATUS[s];
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(CASE_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<DisciplinaryCase>[] = [
    { key: 'code', label: 'Processo', required: true, link: (c) => ['/rh/disciplina', c.id] },
    { key: 'employee', label: 'Colaborador', value: (c) => c.employee.fullName },
    { key: 'occurredOn', label: 'Factos', value: (c) => formatDate(c.occurredOn) },
    {
      key: 'category',
      label: 'Categoria',
      hideOnMobile: true,
      value: (c) => CASE_CATEGORY[c.category] ?? c.category,
    },
    { key: 'summary', label: 'Resumo', hideOnMobile: true },
    { key: 'status', label: 'Estado', value: (c) => this.status(c.status) },
  ];
  protected readonly list = new ListState<DisciplinaryCase>(this.api, {
    url: 'hr/discipline/cases',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });
}
