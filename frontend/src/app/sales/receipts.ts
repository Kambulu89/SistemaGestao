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
import { METHOD, RECEIPT_STATUS, type ReceiptRow, receiptTone } from './receipt-model';

/** Recebimentos de clientes: só contam depois da confirmação financeira por outra pessoa. */
@Component({
  selector: 'app-receipts',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Recebimentos"
      subtitle="Recibos, facturas-recibo e adiantamentos: registados pela cobrança, confirmados pela tesouraria."
      feature="sales"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/vendas/recebimentos/novo" data-testid="rc-new"
          ><app-icon name="plus" [size]="16" />Registar recebimento</a
        >
      }
      <app-filter-bar
        id="rc"
        label="recebimentos"
        placeholder="Número, referência ou cliente"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Recebimentos"
        tableId="sales-receipts"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem recebimentos com estes filtros.'
            : 'Ainda não há recebimentos.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="rc-status">{{
            status(row.status)
          }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class Receipts {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.canAny('sales.receipts.manage'));
  protected readonly tone = receiptTone;
  protected readonly status = (s: string) => RECEIPT_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(RECEIPT_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'advances',
      label: 'Adiantamentos',
      options: [{ value: 'true', label: 'Com saldo disponível' }],
    },
  ];
  protected readonly columns: Column<ReceiptRow>[] = [
    {
      key: 'number',
      label: 'Documento',
      required: true,
      link: (r) => ['/vendas/recebimentos', r.id],
      value: (r) => r.number ?? 'Por confirmar',
    },
    { key: 'customer', label: 'Cliente', value: (r) => `${r.customer.code} — ${r.customer.name}` },
    { key: 'receivedDate', label: 'Data', hideOnMobile: true },
    {
      key: 'method',
      label: 'Meio',
      hideOnMobile: true,
      value: (r) => `${METHOD[r.method]}${r.reference ? ' · ' + r.reference : ''}`,
    },
    { key: 'amount', label: 'Valor', align: 'end', value: (r) => money(r.amount, r.currency) },
    {
      key: 'advance',
      label: 'Adiantamento livre',
      align: 'end',
      hiddenByDefault: true,
      value: (r) => money(r.advanceRemaining, r.currency),
    },
    { key: 'status', label: 'Estado', value: (r) => RECEIPT_STATUS[r.status] },
  ];
  protected readonly list = new ListState<ReceiptRow>(this.api, {
    url: 'sales/receipts',
    filterKeys: ['status', 'advances'],
    sortFields: [],
    limit: 25,
  });
}
