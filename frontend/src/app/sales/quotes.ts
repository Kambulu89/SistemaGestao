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
import { QUOTE_STATUS, type QuoteRow, quoteStatusLabel, quoteTone } from './quote-model';

/** Orçamentos e propostas no âmbito do membro (empresa, entidade legal ou os próprios). */
@Component({
  selector: 'app-quotes',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Orçamentos"
      subtitle="Propostas ao cliente com preços da tabela, aprovação de descontos, envio numerado e versões."
      feature="sales"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/vendas/orcamentos/novo" data-testid="qt-new"
          ><app-icon name="plus" [size]="16" />Novo orçamento</a
        >
      }
      <app-filter-bar
        id="qt"
        label="orçamentos"
        placeholder="Número ou cliente"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Orçamentos"
        tableId="sales-quotes"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem orçamentos com estes filtros.'
            : 'Ainda não há orçamentos.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row)" data-testid="qt-status">{{ status(row) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Quotes {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.canAny('sales.quotes.manage'));
  protected readonly tone = quoteTone;
  protected readonly status = quoteStatusLabel;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: [
        ...Object.entries(QUOTE_STATUS).map(([value, label]) => ({ value, label })),
        { value: 'EXPIRED', label: 'Expirado' },
      ],
    },
  ];
  protected readonly columns: Column<QuoteRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      link: (r) => ['/vendas/orcamentos', r.id],
      value: (r) => (r.number ? `${r.number} v${r.versionNo}` : `Rascunho v${r.versionNo}`),
    },
    { key: 'customer', label: 'Cliente', value: (r) => `${r.customer.code} — ${r.customer.name}` },
    { key: 'legalEntity', label: 'Entidade', hideOnMobile: true },
    { key: 'quoteDate', label: 'Data', hideOnMobile: true },
    { key: 'validUntil', label: 'Válido até', hideOnMobile: true },
    {
      key: 'grossTotal',
      label: 'Total',
      align: 'end',
      value: (r) => money(r.grossTotal, r.currency),
    },
    { key: 'status', label: 'Estado', value: (r) => quoteStatusLabel(r) },
  ];
  protected readonly list = new ListState<QuoteRow>(this.api, {
    url: 'sales/quotes',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });
}
