import { Component, inject } from '@angular/core';
import { Api } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { money } from '../inventory/valuation-model';
import { ACTIVITY_OUTCOME, type CollectionRow } from './collections-model';

/** Lista de cobrança: clientes com valores em dívida, por entidade e moeda, ordenados pelo vencido. */
@Component({
  selector: 'app-collections',
  imports: [EntityListPage, FilterBar, DataTable, CellDef],
  template: `
    <app-entity-list-page
      title="Cobranças"
      subtitle="Contas a receber calculadas das facturas, recibos e notas. Promessas e contactos não alteram saldos."
      feature="sales"
    >
      <app-filter-bar
        id="cb"
        label="cobranças"
        placeholder="Código ou nome do cliente"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Cobranças"
        tableId="sales-collections"
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
            : 'Nenhum cliente com valores em dívida.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="overdue" let-row>
          <span
            [class]="row.overdue !== '0.00' ? 'font-semibold text-danger-text' : ''"
            data-testid="cb-overdue"
            >{{ money(row.overdue, row.currency) }}</span
          >
        </ng-template>
        <ng-template appCell="promises" let-row>
          @if (row.brokenPromises) {
            <span class="badge bg-danger-soft text-danger-text"
              >{{ row.brokenPromises }} falhada(s)</span
            >
          }
          @if (row.openPromises) {
            <span class="badge ml-1 bg-warning-soft text-warning-text"
              >{{ row.openPromises }} em aberto</span
            >
          }
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Collections {
  private readonly api = inject(Api);
  protected readonly money = money;
  protected readonly filters: FilterDef[] = [
    { key: 'overdue', label: 'Vencido', options: [{ value: 'true', label: 'Só com vencido' }] },
  ];
  protected readonly columns: Column<CollectionRow>[] = [
    {
      key: 'customer',
      label: 'Cliente',
      required: true,
      link: (r) => ['/vendas/cobrancas', r.customer.id],
      value: (r) => `${r.customer.code} — ${r.customer.name}`,
    },
    { key: 'entity', label: 'Entidade', hideOnMobile: true, value: (r) => r.legalEntity.code },
    { key: 'open', label: 'Em dívida', align: 'end', value: (r) => money(r.open, r.currency) },
    { key: 'overdue', label: 'Vencido', align: 'end', value: (r) => money(r.overdue, r.currency) },
    {
      key: 'd90',
      label: '> 90 dias',
      align: 'end',
      hiddenByDefault: true,
      value: (r) => money(r.aging.D90_PLUS, r.currency),
    },
    {
      key: 'days',
      label: 'Maior atraso',
      align: 'end',
      hideOnMobile: true,
      value: (r) => (r.maxDaysOverdue ? `${r.maxDaysOverdue} dias` : '—'),
    },
    {
      key: 'last',
      label: 'Último contacto',
      hideOnMobile: true,
      value: (r) =>
        r.lastActivity
          ? `${formatDateTime(r.lastActivity.at)} · ${ACTIVITY_OUTCOME[r.lastActivity.outcome]}`
          : '—',
    },
    {
      key: 'next',
      label: 'Próxima acção',
      hideOnMobile: true,
      value: (r) => r.nextActionDate ?? '—',
    },
    { key: 'promises', label: 'Promessas', value: () => '' },
  ];
  protected readonly list = new ListState<CollectionRow>(this.api, {
    url: 'sales/collections',
    filterKeys: ['overdue'],
    sortFields: [],
    limit: 25,
  });
}
