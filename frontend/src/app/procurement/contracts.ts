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
  CONTRACT_STATUS,
  type ContractRow,
  contractTone,
  type EffectiveStatus,
} from './contract-model';

/** Contratos de fornecedor das entidades do âmbito: vigência, máximo e consumido, alerta de renovação. */
@Component({
  selector: 'app-contracts',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Contratos de fornecedor"
      subtitle="Vigência, valor máximo, preços e níveis de serviço; as ordens de compra consomem o contrato."
      feature="procurement"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/compras/contratos/novo" data-testid="ct-new"
          ><app-icon name="plus" [size]="16" />Novo contrato</a
        >
      }
      <app-filter-bar
        id="ct"
        label="contratos"
        placeholder="Número, título ou fornecedor"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Contratos de fornecedor"
        tableId="proc-contracts"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem contratos com estes filtros.'
            : 'Ainda não há contratos.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="effectiveStatus" let-row>
          <span class="badge" [class]="tone(row.effectiveStatus)" data-testid="ct-status">{{
            status(row.effectiveStatus)
          }}</span>
          @if (row.renewalDue) {
            <span class="badge bg-warning-soft text-warning-text">A renovar</span>
          }
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Contracts {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() =>
    this.workspace.canAny('procurement.contracts.manage'),
  );
  protected readonly tone = contractTone;
  protected readonly status = (s: EffectiveStatus) => CONTRACT_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(CONTRACT_STATUS)
        .filter(([k]) => k !== 'NOT_STARTED')
        .map(([value, label]) => ({ value, label })),
    },
    { key: 'renewalDue', label: 'Renovação', options: [{ value: 'true', label: 'A renovar' }] },
  ];
  protected readonly columns: Column<ContractRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (r) => r.number ?? 'Rascunho',
      link: (r) => ['/compras/contratos', r.id],
    },
    { key: 'title', label: 'Título' },
    {
      key: 'supplier',
      label: 'Fornecedor',
      hideOnMobile: true,
      value: (r) => `${r.supplier.code} — ${r.supplier.name}`,
    },
    {
      key: 'endDate',
      label: 'Vigência',
      hideOnMobile: true,
      value: (r) => `${formatDate(r.startDate)} – ${formatDate(r.endDate)}`,
    },
    {
      key: 'maxAmount',
      label: 'Máximo',
      align: 'end',
      hideOnMobile: true,
      value: (r) => money(r.maxAmount, r.currency),
    },
    {
      key: 'consumedAmount',
      label: 'Consumido',
      align: 'end',
      value: (r) => money(r.consumedAmount, r.currency),
    },
    { key: 'effectiveStatus', label: 'Estado', value: (r) => this.status(r.effectiveStatus) },
  ];
  protected readonly list = new ListState<ContractRow>(this.api, {
    url: 'procurement/contracts',
    filterKeys: ['status', 'renewalDue'],
    sortFields: [],
    limit: 25,
  });
}
