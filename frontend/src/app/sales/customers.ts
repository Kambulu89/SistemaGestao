import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import {
  CUSTOMER_STATUS,
  type CustomerRow,
  type CustomerStatus,
  customerTone,
} from './customer-model';

/** Clientes da empresa: o papel de venda dos terceiros (o mesmo terceiro pode ser fornecedor). */
@Component({
  selector: 'app-customers',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Clientes"
      subtitle="Ficha do terceiro, condições de venda, moradas, limite de crédito e versões dos dados fiscais."
      feature="sales"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/vendas/clientes/novo" data-testid="cu-new"
          ><app-icon name="plus" [size]="16" />Novo cliente</a
        >
      }
      <app-filter-bar
        id="cu"
        label="clientes"
        placeholder="Código, nome ou NIF"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Clientes"
        tableId="sales-customers"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem clientes com estes filtros.'
            : 'Ainda não há clientes.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="cu-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Customers {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.can('sales.customers.manage'));
  protected readonly tone = customerTone;
  protected readonly status = (s: CustomerStatus) => CUSTOMER_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(CUSTOMER_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<CustomerRow>[] = [
    { key: 'code', label: 'Código', required: true, link: (r) => ['/vendas/clientes', r.id] },
    { key: 'name', label: 'Nome' },
    { key: 'taxId', label: 'NIF', hideOnMobile: true, value: (r) => r.taxId ?? '—' },
    { key: 'segment', label: 'Segmento', hideOnMobile: true, value: (r) => r.segment ?? '—' },
    {
      key: 'creditLimit',
      label: 'Limite de crédito',
      align: 'end',
      hideOnMobile: true,
      value: (r) => (r.creditLimit === null ? 'Sem limite' : money(r.creditLimit, r.currency)),
    },
    {
      key: 'paymentTermsDays',
      label: 'Prazo',
      hiddenByDefault: true,
      value: (r) => `${r.paymentTermsDays} dias`,
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<CustomerRow>(this.api, {
    url: 'sales/customers',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });
}
