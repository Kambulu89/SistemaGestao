import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { ListState } from '../ui/list-state';
import { Modal } from '../ui/modal';
import { EntityListPage } from '../ui/templates';
import {
  BUCKET,
  POSTING_TYPE,
  productLabel,
  signedQty,
  sourceLabel,
  type StockMovement,
  type StockPosting,
} from './stock-model';
import { lotLabel } from './lot-model';
import type { Warehouse } from './warehouse-model';

/**
 * Movimentos de stock (kardex, 8.3): cada linha de cada lançamento, do mais recente para o mais antigo. Nada se
 * edita nem apaga; um engano corrige-se com um estorno ou com um novo lançamento, ambos visíveis aqui.
 */
@Component({
  selector: 'app-stock-movements',
  imports: [RouterLink, EntityListPage, FilterBar, DataTable, CellDef, Modal, ErrorAlert],
  template: `
    <app-entity-list-page
      title="Movimentos de stock"
      subtitle="Histórico só de acréscimo: entradas, saídas, mudanças de estado, reservas e estornos."
      permission="inventory.read"
      feature="inventory"
      [anyScope]="true"
    >
      @if (list.filters()['productId']) {
        <p class="mb-3 text-sm" data-testid="mv-product-filter">
          Filtrado pelo produto
          <strong>{{ productName() || '…' }}</strong> ·
          <a class="link" routerLink="/inventario/movimentos">ver todos</a>
        </p>
      }
      <app-filter-bar
        id="mvs"
        label="movimentos"
        [searchable]="false"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Movimentos de stock"
        tableId="inv-movements"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="'Sem movimentos.'"
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="quantity" let-row>
          <span
            class="font-mono"
            [class.text-danger-text]="row.quantity.startsWith('-')"
            [class.text-success-text]="!row.quantity.startsWith('-')"
            >{{ signed(row.quantity) }}</span
          >
        </ng-template>
        <ng-template appCell="posting" let-row>
          <button
            type="button"
            class="link"
            [attr.aria-label]="'Ver lançamento de ' + when(row.occurredAt)"
            (click)="openPosting(row.postingId)"
          >
            Ver
          </button>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>

    <app-modal
      [title]="posting() ? type(posting()!.type) : 'Lançamento'"
      [open]="postingOpen()"
      (closed)="postingOpen.set(false)"
    >
      <app-error-alert [error]="postingError()" [showDetails]="false" />
      @if (posting(); as p) {
        <dl class="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="pd-head">
          <dt class="text-muted">Data</dt>
          <dd>{{ when(p.occurredAt) }}</dd>
          <dt class="text-muted">Origem</dt>
          <dd>{{ source(p.source) }}</dd>
          @if (p.reason) {
            <dt class="text-muted">Motivo</dt>
            <dd>{{ p.reason }}</dd>
          }
          <dt class="text-muted">Por</dt>
          <dd>{{ p.createdBy || '—' }}</dd>
          @if (p.reversalOf) {
            <dt class="text-muted">Estorna</dt>
            <dd>
              <button type="button" class="link" (click)="openPosting(p.reversalOf)">
                lançamento original
              </button>
            </dd>
          }
          @if (p.reversedBy) {
            <dt class="text-muted">Estornado por</dt>
            <dd>
              <button type="button" class="link" (click)="openPosting(p.reversedBy)">
                ver estorno
              </button>
            </dd>
          }
        </dl>
        <ul class="divide-y divide-border text-sm" data-testid="pd-lines">
          @for (l of p.lines; track l.id) {
            <li class="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span
                >{{ label(l) }} · {{ l.warehouse.code
                }}{{ l.location ? ' · ' + l.location.pathCode : '' }}
                <span class="text-xs text-muted">· {{ bucket(l.bucket) }}</span></span
              >
              <span class="font-mono">{{ signed(l.quantity) }} {{ l.uom }}</span>
            </li>
          }
        </ul>
      }
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="postingOpen.set(false)">Fechar</button>
      </ng-container>
    </app-modal>
  `,
})
export class StockMovements {
  private readonly api = inject(Api);
  protected readonly signed = signedQty;
  protected readonly when = formatDateTime;
  protected readonly label = productLabel;
  protected readonly source = sourceLabel;
  private readonly warehouses = signal<Warehouse[]>([]);
  protected readonly posting = signal<StockPosting | null>(null);
  protected readonly postingOpen = signal(false);
  protected readonly postingError = signal<ApiError | null>(null);
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'warehouseId',
      label: 'Armazém',
      options: this.warehouses().map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
    },
    {
      key: 'type',
      label: 'Tipo',
      options: Object.entries(POSTING_TYPE).map(([value, label]) => ({ value, label })),
    },
  ]);
  protected readonly productName = computed(() => {
    const first = this.list.page.value()?.items[0];
    return first ? `${productLabel(first)} — ${first.product.name}` : '';
  });
  protected readonly columns: Column<StockMovement>[] = [
    {
      key: 'occurredAt',
      label: 'Data',
      required: true,
      value: (m) => formatDateTime(m.occurredAt),
    },
    { key: 'type', label: 'Tipo', value: (m) => this.type(m.type) },
    {
      key: 'product',
      label: 'Produto',
      value: (m) => productLabel(m),
      link: (m) => ['/inventario/produtos', m.product.id],
    },
    {
      key: 'where',
      label: 'Armazém',
      value: (m) =>
        m.location ? `${m.warehouse.code} · ${m.location.pathCode}` : m.warehouse.code,
    },
    {
      key: 'lot',
      label: 'Lote',
      hideOnMobile: true,
      value: (m) => (m.lot ? lotLabel(m.lot) : '—'),
      link: (m) => (m.lot ? ['/inventario/lotes', m.lot.id] : null),
    },
    { key: 'bucket', label: 'Estado', hideOnMobile: true, value: (m) => this.bucket(m.bucket) },
    { key: 'quantity', label: 'Quantidade', align: 'end', value: (m) => signedQty(m.quantity) },
    { key: 'uom', label: 'Un.', hideOnMobile: true },
    {
      key: 'source',
      label: 'Origem',
      hideOnMobile: true,
      value: (m) => m.reason ?? sourceLabel(m.source),
    },
    { key: 'user', label: 'Por', hideOnMobile: true, value: (m) => m.user ?? '—' },
    { key: 'posting', label: 'Lançamento', required: true },
  ];
  protected readonly list = new ListState<StockMovement>(this.api, {
    url: 'inventory/stock/movements',
    filterKeys: ['warehouseId', 'productId', 'variantId', 'type'],
    sortFields: [],
    limit: 50,
  });

  constructor() {
    this.api.get<Warehouse[]>('inventory/warehouses', { limit: 200 }).then(
      (w) => this.warehouses.set(w),
      () => undefined,
    );
  }

  protected type(t: string) {
    return POSTING_TYPE[t] ?? t;
  }

  protected bucket(b: string) {
    return BUCKET[b as keyof typeof BUCKET] ?? b;
  }

  protected async openPosting(id: string) {
    this.postingError.set(null);
    this.postingOpen.set(true);
    try {
      this.posting.set(await this.api.get<StockPosting>(`inventory/stock/postings/${id}`));
    } catch (error) {
      this.posting.set(null);
      this.postingError.set(ApiError.from(error));
    }
  }
}
