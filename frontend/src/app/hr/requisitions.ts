import { Component, computed, effect, inject, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatMoney } from '../ui/money-input';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import {
  type Requisition,
  REQUISITION_STATUS,
  type RequisitionStatus,
  tone,
} from './recruitment-model';

/** Vagas (EntityListPage): a API devolve só as do âmbito do membro (entidade, filial, departamento ou empresa). */
@Component({
  selector: 'app-requisitions',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Vagas"
      subtitle="Requisições de pessoal: cargo, requisitos, quantidade, prazo e remuneração autorizada."
      permission="hr.recruitment.read"
      feature="hr"
      [anyScope]="true"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/rh/vagas/nova"
          ><app-icon name="plus" [size]="16" />Nova vaga</a
        >
      }
      <app-filter-bar
        id="req"
        label="vagas"
        placeholder="Código ou título"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Vagas"
        tableId="hr-requisitions"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [sort]="list.sort()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem vagas com estes filtros.'
            : 'Ainda não há vagas no seu âmbito.'
        "
        (sortChange)="list.setSort($event)"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ statusLabel(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Requisitions {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.canAny('hr.recruitment.manage'));
  protected readonly tone = tone;
  protected readonly statusLabel = (s: RequisitionStatus) => REQUISITION_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(REQUISITION_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<Requisition>[] = [
    {
      key: 'code',
      label: 'Código',
      sortable: true,
      required: true,
      link: (r) => ['/rh/vagas', r.id],
    },
    { key: 'title', label: 'Título', sortable: true },
    { key: 'position', label: 'Cargo', hideOnMobile: true, value: (r) => r.position.name },
    { key: 'departmentName', label: 'Departamento', hideOnMobile: true },
    {
      key: 'quantity',
      label: 'Postos',
      align: 'end',
      value: (r) => `${r.hiredCount}/${r.quantity}`,
    },
    {
      key: 'salaryMax',
      label: 'Remuneração autorizada',
      hideOnMobile: true,
      hiddenByDefault: true,
      value: (r) => `${formatMoney(r.salaryMin)} – ${formatMoney(r.salaryMax)} ${r.currency}`,
    },
    { key: 'applicationsCount', label: 'Candidaturas', align: 'end', hideOnMobile: true },
    {
      key: 'deadline',
      label: 'Prazo',
      sortable: true,
      hideOnMobile: true,
      value: (r) => formatDate(r.deadline),
    },
    { key: 'status', label: 'Estado', sortable: true, value: (r) => this.statusLabel(r.status) },
  ];
  protected readonly list = new ListState<Requisition>(this.api, {
    url: 'hr/requisitions',
    filterKeys: ['status'],
    sortFields: ['code', 'title', 'deadline', 'status', 'createdAt'],
    limit: 25,
    extra: () => ({ legalEntityId: this.workspace.legalEntityId() ?? undefined }),
  });

  constructor() {
    let first = true;
    effect(() => {
      this.workspace.legalEntityId();
      untracked(() => {
        if (!first) void this.list.reload();
        first = false;
      });
    });
  }
}
