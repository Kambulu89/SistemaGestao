import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import { RFQ_STATUS, type RfqRow, type RfqStatus, rfqTone } from './rfq-model';

/** Pedidos de cotação das entidades do âmbito, com convidados, propostas recebidas e prazo. */
@Component({
  selector: 'app-rfqs',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Pedidos de cotação"
      subtitle="Pedidos a fornecedores homologados, com prazo de resposta e propostas em envelope fechado até à abertura."
      feature="procurement"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/compras/cotacoes/nova" data-testid="rfq-new"
          ><app-icon name="plus" [size]="16" />Novo pedido</a
        >
      }
      <app-filter-bar
        id="rfq"
        label="pedidos de cotação"
        placeholder="Número ou título"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Pedidos de cotação"
        tableId="proc-rfqs"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem pedidos com estes filtros.'
            : 'Ainda não há pedidos de cotação.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="rfq-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Rfqs {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.canAny('procurement.rfqs.manage'));
  protected readonly tone = rfqTone;
  protected readonly status = (s: RfqStatus) => RFQ_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(RFQ_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<RfqRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (r) => r.number ?? 'Rascunho',
      link: (r) => ['/compras/cotacoes', r.id],
    },
    { key: 'title', label: 'Título' },
    { key: 'legalEntity', label: 'Entidade', hideOnMobile: true, value: (r) => r.legalEntity.code },
    {
      key: 'closesAt',
      label: 'Prazo de resposta',
      hideOnMobile: true,
      value: (r) => formatDateTime(r.closesAt),
    },
    { key: 'invited', label: 'Convidados', align: 'end', hideOnMobile: true },
    { key: 'quotes', label: 'Propostas', align: 'end' },
    {
      key: 'sealed',
      label: 'Envelope',
      hiddenByDefault: true,
      value: (r) => (r.sealed ? 'Fechado' : 'Aberto'),
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<RfqRow>(this.api, {
    url: 'procurement/rfqs',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });
}
