import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import {
  LIST_TARGET,
  period,
  type PriceListRow,
  PRICING_STATUS,
  type PricingStatus,
  pricingTone,
  targetLabel,
} from './pricing-model';

/** Tabelas de preços: geral, por segmento ou por cliente; activas só depois de aprovadas por outra pessoa. */
@Component({
  selector: 'app-price-lists',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Tabelas de preços"
      subtitle="Preço por produto e escalão de quantidade, numa moeda e período; a mais específica e prioritária ganha."
      feature="sales"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/vendas/precos/novo" data-testid="pl-new"
          ><app-icon name="plus" [size]="16" />Nova tabela</a
        >
      }
      <app-filter-bar
        id="pl"
        label="tabelas de preços"
        placeholder="Código ou nome"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Tabelas de preços"
        tableId="sales-price-lists"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem tabelas com estes filtros.'
            : 'Ainda não há tabelas de preços.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="pl-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class PriceLists {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.can('sales.prices.manage'));
  protected readonly tone = pricingTone;
  protected readonly status = (s: PricingStatus) => PRICING_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(PRICING_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'targetType',
      label: 'Destino',
      options: Object.entries(LIST_TARGET).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<PriceListRow>[] = [
    { key: 'code', label: 'Código', required: true, link: (r) => ['/vendas/precos', r.id] },
    { key: 'name', label: 'Nome' },
    { key: 'target', label: 'Destino', value: (r) => targetLabel(r) },
    { key: 'currency', label: 'Moeda', hideOnMobile: true },
    {
      key: 'period',
      label: 'Período',
      hideOnMobile: true,
      value: (r) => period(r.validFrom, r.validTo),
    },
    {
      key: 'priority',
      label: 'Prioridade',
      align: 'end',
      hiddenByDefault: true,
      value: (r) => String(r.priority),
    },
    {
      key: 'lines',
      label: 'Preços',
      align: 'end',
      hideOnMobile: true,
      value: (r) => String(r.lines),
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<PriceListRow>(this.api, {
    url: 'sales/price-lists',
    filterKeys: ['status', 'targetType'],
    sortFields: [],
    limit: 25,
  });
}
