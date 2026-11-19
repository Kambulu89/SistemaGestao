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
import { RECEIPT_STATUS, type ReceiptRow, type ReceiptStatus, receiptTone } from './receipt-model';

/** Recepções de compra das entidades do âmbito: o que entrou (ou foi aceite) de cada ordem. */
@Component({
  selector: 'app-receipts',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Recepções de compra"
      subtitle="Conferência do que chega das ordens emitidas: bens entram no inventário, serviços ficam aceites."
      feature="procurement"
    >
      @if (canManage()) {
        <a
          actions
          class="btn-secondary"
          routerLink="/compras/entregas-previstas"
          data-testid="re-expected"
          ><app-icon name="calendar" [size]="16" />Entregas previstas</a
        >
      }
      <app-filter-bar
        id="re"
        label="recepções"
        placeholder="Número, ordem, fornecedor ou guia"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Recepções de compra"
        tableId="proc-receipts"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem recepções com estes filtros.'
            : 'Ainda não há recepções.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)" data-testid="re-status">{{
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
  protected readonly canManage = computed(() =>
    this.workspace.canAny('procurement.receipts.manage'),
  );
  protected readonly tone = receiptTone;
  protected readonly status = (s: ReceiptStatus) => RECEIPT_STATUS[s] ?? s;
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(RECEIPT_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<ReceiptRow>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (r) => r.number ?? 'Rascunho',
      link: (r) => ['/compras/recepcoes', r.id],
    },
    { key: 'order', label: 'Ordem', value: (r) => r.order.number },
    {
      key: 'supplier',
      label: 'Fornecedor',
      hideOnMobile: true,
      value: (r) => `${r.supplier.code} — ${r.supplier.name}`,
    },
    {
      key: 'receiptDate',
      label: 'Data',
      hideOnMobile: true,
      value: (r) => formatDate(r.receiptDate),
    },
    { key: 'deliveryNote', label: 'Guia', hideOnMobile: true, value: (r) => r.deliveryNote ?? '—' },
    {
      key: 'warehouse',
      label: 'Armazém',
      hiddenByDefault: true,
      value: (r) => r.warehouse?.code ?? '—',
    },
    { key: 'status', label: 'Estado', value: (r) => this.status(r.status) },
  ];
  protected readonly list = new ListState<ReceiptRow>(this.api, {
    url: 'procurement/receipts',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });
}
