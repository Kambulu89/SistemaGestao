import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import {
  PRIORITY,
  REQUISITION_STATUS,
  type RequisitionRow,
  type RequisitionStatus,
  requisitionTone,
} from './requisition-model';

/** Requisições de compra: as do âmbito de quem pede, aprova ou compra; filtro "à espera da minha decisão". */
@Component({
  selector: 'app-purchase-requisitions',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Requisições de compra"
      subtitle="Pedidos dos departamentos, aprovados por etapas consoante o valor, e depois cotados e encomendados."
      feature="procurement"
    >
      @if (canRequest()) {
        <a actions class="btn-primary" routerLink="/compras/requisicoes/nova" data-testid="pr-new"
          ><app-icon name="plus" [size]="16" />Nova requisição</a
        >
      }
      <app-filter-bar
        id="pr"
        label="requisições"
        placeholder="Número ou finalidade"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Requisições de compra"
        tableId="proc-requisitions"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem requisições com estes filtros.'
            : 'Ainda não há requisições.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="pr-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class PurchaseRequisitions {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canRequest = computed(() =>
    this.workspace.canAny('procurement.requisitions.request'),
  );
  protected readonly tone = requisitionTone;
  protected readonly status = (s: RequisitionStatus) => REQUISITION_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(REQUISITION_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'priority',
      label: 'Prioridade',
      options: Object.entries(PRIORITY).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'awaitingMe',
      label: 'Decisão',
      options: [{ value: 'true', label: 'À espera da minha decisão' }],
    },
    { key: 'mine', label: 'Pedidas por mim', options: [{ value: 'true', label: 'Sim' }] },
  ];
  protected readonly columns: Column<RequisitionRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (r) => r.number ?? 'Rascunho',
      link: (r) => ['/compras/requisicoes', r.id],
    },
    { key: 'purpose', label: 'Finalidade' },
    {
      key: 'department',
      label: 'Departamento',
      hideOnMobile: true,
      value: (r) => r.department.code,
    },
    { key: 'requestedBy', label: 'Pedida por', hideOnMobile: true, hiddenByDefault: true },
    {
      key: 'priority',
      label: 'Prioridade',
      hideOnMobile: true,
      value: (r) => PRIORITY[r.priority],
    },
    {
      key: 'neededBy',
      label: 'Necessária a',
      hideOnMobile: true,
      value: (r) => formatDate(r.neededBy),
    },
    {
      key: 'totalAmount',
      label: 'Total estimado',
      align: 'end',
      value: (r) => money(r.totalAmount, r.currency),
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<RequisitionRow>(this.api, {
    url: 'procurement/requisitions',
    filterKeys: ['status', 'priority', 'awaitingMe', 'mine'],
    sortFields: [],
    limit: 25,
  });
}
