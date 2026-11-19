import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { ErrorAlert } from '../ui/error-alert';
import { exportList, withoutPaging } from '../ui/export';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  BUCKET,
  newKey,
  productLabel,
  qty,
  type Reconciliation,
  STATUS_BUCKETS,
  type StatusBucket,
  type StockBalance,
  statusQuantityError,
} from './stock-model';
import { lotLabel } from './lot-model';
import type { Warehouse } from './warehouse-model';

const FIELD: Record<StatusBucket, 'unrestricted' | 'blocked' | 'quarantine'> = {
  UNRESTRICTED: 'unrestricted',
  BLOCKED: 'blocked',
  QUARANTINE: 'quarantine',
};

/**
 * Stock por armazém, localização e produto (8.3): físico, disponível e cada balde (livre, reservado, bloqueado,
 * quarentena, em trânsito, previsto). Os saldos derivam dos movimentos: aqui só se consulta, confere com os movimentos
 * e muda o estado (livre ↔ bloqueado ↔ quarentena), que é um lançamento como os outros.
 */
@Component({
  selector: 'app-stock',
  imports: [
    FormsModule,
    RouterLink,
    EntityListPage,
    FilterBar,
    DataTable,
    CellDef,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    Icon,
  ],
  template: `
    <app-entity-list-page
      title="Stock"
      subtitle="Saldos derivados dos movimentos confirmados. Físico = livre + bloqueado + quarentena; disponível = livre − reservado."
      permission="inventory.read"
      feature="inventory"
      [anyScope]="true"
    >
      <button
        actions
        type="button"
        class="btn-secondary"
        data-testid="st-reconcile"
        [disabled]="reconciling()"
        (click)="reconcile()"
      >
        <app-icon name="check" [size]="16" />Conferir saldos
      </button>
      @if (recon(); as r) {
        <div
          role="status"
          data-testid="st-recon"
          class="mb-3 rounded-md border px-3 py-2 text-sm"
          [class]="
            r.differences.length
              ? 'border-danger-border bg-danger-soft text-danger-text'
              : 'border-border bg-success-soft text-success-text'
          "
        >
          {{
            r.differences.length
              ? r.differences.length +
                ' saldo(s) diferem da soma dos movimentos — contacte o suporte.'
              : r.checked + ' saldo(s) conferidos com os movimentos: sem diferenças.'
          }}
        </div>
      }
      <app-filter-bar
        id="stk"
        label="stock"
        placeholder="SKU ou nome"
        [state]="list"
        [filters]="filters()"
      />
      <app-data-table
        label="Stock"
        tableId="inv-stock"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [exportable]="true"
        [exporting]="exporting()"
        [emptyText]="
          list.q() || list.activeFilters()
            ? 'Sem stock com estes filtros.'
            : 'Sem stock nos armazéns do seu âmbito.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
        (export)="export($event)"
      >
        <ng-template appCell="actions" let-row>
          <span class="flex justify-end gap-3">
            <a
              class="link"
              routerLink="/inventario/movimentos"
              [queryParams]="{ productId: row.product.id, warehouseId: row.warehouse.id }"
              [attr.aria-label]="'Movimentos de ' + label(row) + ' em ' + row.warehouse.code"
              >Movimentos</a
            >
            @if (canManage()) {
              <button
                type="button"
                class="link"
                [attr.aria-label]="'Mudar estado de ' + label(row) + ' em ' + where(row)"
                (click)="openStatus(row)"
              >
                Mudar estado
              </button>
            }
          </span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>

    <app-modal title="Mudar estado do stock" [open]="statusOpen()" (closed)="statusOpen.set(false)">
      @if (target(); as t) {
        <p class="mb-3 text-sm text-muted" data-testid="sc-target">
          {{ label(t) }} — {{ t.product.name }} · {{ where(t) }}
        </p>
        <app-error-alert [error]="action.error()" [showDetails]="true" />
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field label="De" [required]="true">
            <select
              appControl
              class="input"
              data-testid="sc-from"
              [(ngModel)]="form.from"
              [ngModelOptions]="{ standalone: true }"
            >
              @for (b of buckets; track b) {
                <option [value]="b">{{ bucket[b] }} ({{ amount(t, b) }} {{ t.uom }})</option>
              }
            </select>
          </app-field>
          <app-field label="Para" [required]="true">
            <select
              appControl
              class="input"
              data-testid="sc-to"
              [(ngModel)]="form.to"
              [ngModelOptions]="{ standalone: true }"
            >
              @for (b of buckets; track b) {
                @if (b !== form.from) {
                  <option [value]="b">{{ bucket[b] }}</option>
                }
              }
            </select>
          </app-field>
          <app-field
            label="Quantidade"
            [required]="true"
            [hint]="'Em ' + t.uom + (t.uomDecimals ? ', até ' + t.uomDecimals + ' casas' : '')"
            [error]="quantityError() ?? action.field('quantity')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="sc-qty"
              [(ngModel)]="form.quantity"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field
            label="Motivo"
            [required]="true"
            hint="Fica no lançamento e na auditoria."
            [error]="action.field('reason')"
          >
            <input
              appControl
              class="input"
              maxlength="300"
              data-testid="sc-reason"
              [(ngModel)]="form.reason"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        </div>
      }
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="statusOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="sc-save"
          [disabled]="action.busy()"
          (click)="saveStatus()"
        >
          Lançar mudança
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class Stock {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly bucket = BUCKET;
  protected readonly buckets = STATUS_BUCKETS;
  protected readonly label = productLabel;
  protected readonly canManage = computed(() => this.workspace.canAny('inventory.stock.manage'));
  private readonly warehouses = signal<Warehouse[]>([]);
  protected readonly exporting = signal(false);
  protected readonly reconciling = signal(false);
  protected readonly recon = signal<Reconciliation | null>(null);
  protected readonly statusOpen = signal(false);
  protected readonly target = signal<StockBalance | null>(null);
  protected readonly action = new Action();
  protected form = {
    from: 'UNRESTRICTED' as StatusBucket,
    to: 'BLOCKED' as StatusBucket,
    quantity: '',
    reason: '',
    key: '',
  };
  private readonly checked = signal(false);
  protected readonly filters = computed<FilterDef[]>(() => [
    {
      key: 'warehouseId',
      label: 'Armazém',
      options: this.warehouses().map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
    },
  ]);
  protected readonly columns: Column<StockBalance>[] = [
    {
      key: 'product',
      label: 'Produto',
      required: true,
      value: (r) => productLabel(r),
      link: (r) => ['/inventario/produtos', r.product.id],
    },
    { key: 'name', label: 'Nome', hideOnMobile: true, value: (r) => r.product.name },
    { key: 'warehouse', label: 'Armazém', value: (r) => r.warehouse.code },
    {
      key: 'location',
      label: 'Localização',
      hideOnMobile: true,
      value: (r) => r.location?.pathCode ?? '—',
    },
    {
      key: 'lot',
      label: 'Lote',
      hideOnMobile: true,
      value: (r) => (r.lot ? lotLabel(r.lot) : '—'),
      link: (r) => (r.lot ? ['/inventario/lotes', r.lot.id] : null),
    },
    { key: 'physical', label: 'Físico', align: 'end', value: (r) => qty(r.physical) },
    { key: 'available', label: 'Disponível', align: 'end', value: (r) => qty(r.available) },
    {
      key: 'reserved',
      label: 'Reservado',
      align: 'end',
      hideOnMobile: true,
      value: (r) => qty(r.reserved),
    },
    {
      key: 'blocked',
      label: 'Bloqueado',
      align: 'end',
      hideOnMobile: true,
      value: (r) => qty(r.blocked),
    },
    {
      key: 'quarantine',
      label: 'Quarentena',
      align: 'end',
      hideOnMobile: true,
      value: (r) => qty(r.quarantine),
    },
    {
      key: 'inTransit',
      label: 'Em trânsito',
      align: 'end',
      hideOnMobile: true,
      value: (r) => qty(r.inTransit),
    },
    {
      key: 'expected',
      label: 'Previsto',
      align: 'end',
      hideOnMobile: true,
      value: (r) => qty(r.expected),
    },
    { key: 'uom', label: 'Un.', hideOnMobile: true },
    { key: 'actions', label: 'Acções', required: true },
  ];
  protected readonly list = new ListState<StockBalance>(this.api, {
    url: 'inventory/stock/balances',
    filterKeys: ['warehouseId', 'productId'],
    sortFields: [],
    limit: 50,
  });

  constructor() {
    this.api.get<Warehouse[]>('inventory/warehouses', { limit: 200 }).then(
      (w) => this.warehouses.set(w),
      () => undefined,
    );
  }

  protected where(r: StockBalance) {
    return r.location ? `${r.warehouse.code} · ${r.location.pathCode}` : r.warehouse.code;
  }

  protected amount(r: StockBalance, b: StatusBucket) {
    return qty(r[FIELD[b]]);
  }

  protected quantityError() {
    const t = this.target();
    if (!t || !this.checked() || !this.form.quantity.trim()) return null;
    return statusQuantityError(this.form.quantity, t[FIELD[this.form.from]], t.uomDecimals);
  }

  protected openStatus(r: StockBalance) {
    this.action.error.set(null);
    this.checked.set(false);
    const from = STATUS_BUCKETS.find((b) => Number(r[FIELD[b]]) > 0) ?? 'UNRESTRICTED';
    this.form = {
      from,
      to: from === 'UNRESTRICTED' ? 'BLOCKED' : 'UNRESTRICTED',
      quantity: '',
      reason: '',
      // Uma chave por abertura do formulário: repetir o envio (ex.: rede) não duplica o lançamento.
      key: newKey('status'),
    };
    this.target.set(r);
    this.statusOpen.set(true);
  }

  protected async saveStatus() {
    const t = this.target()!;
    this.checked.set(true);
    if (this.form.to === this.form.from)
      this.form.to = this.form.from === 'UNRESTRICTED' ? 'BLOCKED' : 'UNRESTRICTED';
    if (!this.form.quantity.trim() || this.quantityError()) {
      if (!this.form.quantity.trim())
        this.action.error.set(new ApiError(422, 'VALIDATION_ERROR', 'Indique a quantidade.'));
      return;
    }
    const r = await this.action.run(() =>
      this.api.post('inventory/stock/status-changes', {
        warehouseId: t.warehouse.id,
        locationId: t.location?.id ?? null,
        productId: t.product.id,
        variantId: t.variant?.id ?? null,
        from: this.form.from,
        to: this.form.to,
        quantity: this.form.quantity.trim().replace(',', '.'),
        reason: this.form.reason.trim(),
        idempotencyKey: this.form.key,
      }),
    );
    if (!r) return;
    this.statusOpen.set(false);
    this.toasts.show(`Lançado: ${BUCKET[this.form.from]} → ${BUCKET[this.form.to]}.`);
    await this.list.reload();
  }

  protected async reconcile() {
    this.reconciling.set(true);
    try {
      const f = this.list.filters()['warehouseId'];
      this.recon.set(
        await this.api.get<Reconciliation>(
          'inventory/stock/reconciliation',
          f ? { warehouseId: f } : {},
        ),
      );
    } catch {
      this.toasts.show('Não foi possível conferir os saldos.', 'error');
    } finally {
      this.reconciling.set(false);
    }
  }

  protected async export(columns: Column<StockBalance>[]) {
    this.exporting.set(true);
    try {
      const n = await exportList(
        this.api,
        'inventory/stock/balances',
        withoutPaging(this.list.query()),
        columns.filter((c) => c.key !== 'actions'),
        'stock.csv',
      );
      this.toasts.show(`Exportados ${n} saldo(s).`);
    } catch {
      this.toasts.show('Não foi possível exportar.', 'error');
    } finally {
      this.exporting.set(false);
    }
  }
}
