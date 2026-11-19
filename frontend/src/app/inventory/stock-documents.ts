import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { EntityListPage } from '../ui/templates';
import {
  DOC_STATUS,
  DOC_TYPE,
  type DocStatus,
  ORIGIN,
  type StockDocument,
  statusTone,
} from './stock-document-model';
import type { Warehouse } from './warehouse-model';

/** Entradas e saídas de stock (8.4): o stock só muda quando o documento é confirmado. */
@Component({
  selector: 'app-stock-documents',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Icon],
  template: `
    <app-entity-list-page
      title="Entradas e saídas"
      subtitle="Documentos de stock: rascunho → conferência → confirmação (parcial ou total). Só a confirmação movimenta o stock."
      permission="inventory.read"
      feature="inventory"
      [anyScope]="true"
    >
      @if (canManage()) {
        <span actions class="flex flex-wrap gap-2">
          <a
            class="btn-primary"
            routerLink="/inventario/documentos/novo"
            [queryParams]="{ tipo: 'RECEIPT' }"
            data-testid="doc-new-receipt"
            ><app-icon name="plus" [size]="16" />Nova entrada</a
          >
          <a
            class="btn-secondary"
            routerLink="/inventario/documentos/novo"
            [queryParams]="{ tipo: 'ISSUE' }"
            data-testid="doc-new-issue"
            ><app-icon name="plus" [size]="16" />Nova saída</a
          >
        </span>
      }
      <app-filter-bar
        id="docs"
        label="documentos"
        placeholder="Número, referência ou contraparte"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Entradas e saídas"
        tableId="inv-documents"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.q() || list.activeFilters() ? 'Sem documentos com estes filtros.' : 'Sem documentos.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)"
            >{{ status(row.status) }}{{ row.closedShort ? ' · saldo fechado' : '' }}</span
          >
        </ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class StockDocuments {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly tone = statusTone;
  protected readonly canManage = computed(() =>
    this.workspace.canAny('inventory.documents.manage'),
  );
  private readonly warehouses = signal<Warehouse[]>([]);
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'docType',
      label: 'Tipo',
      options: Object.entries(DOC_TYPE).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(DOC_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'warehouseId',
      label: 'Armazém',
      options: this.warehouses().map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
    },
  ]);
  protected readonly columns: Column<StockDocument>[] = [
    {
      key: 'number',
      label: 'Número',
      required: true,
      value: (d) => d.number ?? 'Rascunho',
      link: (d) => ['/inventario/documentos', d.id],
    },
    { key: 'docType', label: 'Tipo', value: (d) => DOC_TYPE[d.docType] },
    { key: 'documentDate', label: 'Data', value: (d) => formatDate(d.documentDate) },
    { key: 'warehouse', label: 'Armazém', value: (d) => d.warehouse.code },
    {
      key: 'origin',
      label: 'Origem',
      hideOnMobile: true,
      value: (d) => ORIGIN[d.origin] ?? d.origin,
    },
    {
      key: 'ref',
      label: 'Referência',
      hideOnMobile: true,
      value: (d) => [d.originRef, d.counterparty].filter(Boolean).join(' · ') || '—',
    },
    { key: 'lineCount', label: 'Linhas', align: 'end', hideOnMobile: true },
    { key: 'status', label: 'Estado', value: (d) => DOC_STATUS[d.status] },
  ];
  protected readonly list = new ListState<StockDocument>(this.api, {
    url: 'inventory/documents',
    filterKeys: ['docType', 'status', 'warehouseId'],
    sortFields: [],
    limit: 25,
  });

  constructor() {
    this.api.get<Warehouse[]>('inventory/warehouses', { limit: 200 }).then(
      (w) => this.warehouses.set(w),
      () => undefined,
    );
  }

  protected status(s: DocStatus) {
    return DOC_STATUS[s];
  }
}
