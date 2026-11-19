import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import {
  TERMINATION_REASON,
  TERMINATION_STATUS,
  type Termination,
  type TerminationStatus,
  terminationTone,
} from './termination-model';

/** Cessações no âmbito (nunca a própria). Iniciam-se na ficha do colaborador. */
@Component({
  selector: 'app-terminations',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Cessações"
      subtitle="Saídas de colaboradores: aviso, liquidação final e checklist. Iniciam-se na ficha do colaborador."
      permission="hr.terminations.read"
      feature="hr"
      [anyScope]="true"
    >
      <app-filter-bar
        id="ces"
        label="cessações"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Cessações"
        tableId="hr-terminations"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.activeFilters() ? 'Sem cessações com estes filtros.' : 'Sem cessações no seu âmbito.'
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
export class Terminations {
  private readonly api = inject(Api);
  protected readonly tone = terminationTone;
  protected readonly status = (s: TerminationStatus) => TERMINATION_STATUS[s];
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(TERMINATION_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<Termination>[] = [
    { key: 'code', label: 'Processo', required: true, link: (t) => ['/rh/cessacoes', t.id] },
    { key: 'employee', label: 'Colaborador', value: (t) => t.employee.fullName },
    { key: 'lastWorkingDay', label: 'Último dia', value: (t) => formatDate(t.lastWorkingDay) },
    {
      key: 'reason',
      label: 'Motivo',
      hideOnMobile: true,
      value: (t) => TERMINATION_REASON[t.reason] ?? t.reason,
    },
    { key: 'status', label: 'Estado', value: (t) => this.status(t.status) },
  ];
  protected readonly list = new ListState<Termination>(this.api, {
    url: 'hr/terminations',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });
}
