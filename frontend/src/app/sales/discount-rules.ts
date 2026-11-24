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
  type DiscountRule,
  percent,
  period,
  PRICING_STATUS,
  type PricingStatus,
  pricingTone,
  ruleScope,
  targetLabel,
} from './pricing-model';

/** Descontos automáticos: uma regra por linha (não acumulam), escolhida pela prioridade. */
@Component({
  selector: 'app-discount-rules',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Regras de desconto"
      subtitle="Percentagem para todos, um segmento ou um cliente, num produto, categoria ou em tudo, a partir de uma quantidade."
      feature="sales"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/vendas/descontos/novo" data-testid="dr-new"
          ><app-icon name="plus" [size]="16" />Nova regra</a
        >
      }
      <app-filter-bar
        id="dr"
        label="regras de desconto"
        placeholder="Código ou nome"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Regras de desconto"
        tableId="sales-discount-rules"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem regras com estes filtros.'
            : 'Ainda não há regras.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="dr-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class DiscountRules {
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
  ];
  protected readonly columns: Column<DiscountRule>[] = [
    { key: 'code', label: 'Código', required: true, link: (r) => ['/vendas/descontos', r.id] },
    { key: 'name', label: 'Nome' },
    { key: 'target', label: 'Clientes', value: (r) => targetLabel(r) },
    { key: 'scope', label: 'Âmbito', hideOnMobile: true, value: (r) => ruleScope(r) },
    { key: 'discountPct', label: 'Desconto', align: 'end', value: (r) => percent(r.discountPct) },
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
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<DiscountRule>(this.api, {
    url: 'sales/discount-rules',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });
}
