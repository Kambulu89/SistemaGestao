import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, switchMap, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { OrdersApi } from '../../sales/orders/orders.api';
import { PurchasingApi, type PurchaseDto } from './purchasing.api';
import {
  formatDecimal,
  isMoney,
  isPositiveQuantity,
  isTaxRate,
  PURCHASE_STATUS,
  purchasingError,
  trimQuantity,
} from './purchasing-model';

/**
 * Encomendas a fornecedor (M06): rascunho com custos e impostos exactos → confirmada (número) → recebida pelas recepções.
 * Confirmar não recebe: a entrada de stock é uma recepção. Só se cancela enquanto nada foi recebido.
 */
@Component({
  selector: 'app-purchasing-orders',
  imports: [
    DatePipe,
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-3 block">
        {{ text }}
      </app-alert>
    }

    @if (creating()) {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">Nova encomenda a fornecedor</h2>
        <app-select
          label="Fornecedor"
          placeholder="Escolha o fornecedor"
          [required]="true"
          [options]="supplierOptions()"
          [ngModel]="supplierId()"
          (ngModelChange)="supplierId.set($event ?? '')"
        />
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (order(); as o) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ o.number ?? 'Encomenda em rascunho' }}
            <app-badge class="ms-2" [tone]="status(o).tone">{{ status(o).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted"
            >{{ supplierName(o.supplierId) }} · {{ o.currency }} ·
            {{ o.orderDate | date: 'dd/MM/yyyy' }}</span
          >
        </div>
        @if (o.cancelReason) {
          <p class="mt-2 text-sm">Cancelada: {{ o.cancelReason }}</p>
        }
        <div class="mt-4 overflow-x-auto">
          <table class="w-full text-sm" data-testid="purchase-lines">
            <thead>
              <tr class="text-left text-fg-muted">
                <th class="py-1 pe-3">Descrição</th>
                <th class="py-1 pe-3 text-end">Qtd.</th>
                <th class="py-1 pe-3 text-end">Recebida</th>
                <th class="py-1 pe-3 text-end">Custo</th>
                <th class="py-1 pe-3 text-end">Líquido</th>
                <th class="py-1 pe-3 text-end">Imposto</th>
                <th class="py-1 pe-3 text-end">Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (line of o.lines ?? []; track line.id) {
                <tr class="border-t border-line">
                  <td class="py-2 pe-3">{{ line.description }}</td>
                  <td class="py-2 pe-3 text-end">{{ trim(line.quantity) }}</td>
                  <td class="py-2 pe-3 text-end">{{ trim(line.receivedQty ?? '0') }}</td>
                  <td class="py-2 pe-3 text-end">{{ money(line.unitCost) }}</td>
                  <td class="py-2 pe-3 text-end">{{ money(line.netAmount) }}</td>
                  <td class="py-2 pe-3 text-end">{{ money(line.taxAmount) }}</td>
                  <td class="py-2 pe-3 text-end">{{ money(line.total) }}</td>
                  <td class="py-2 text-end">
                    @if (o.status === 'DRAFT' && canManage()) {
                      <app-button size="sm" variant="secondary" (click)="removeLine(line.id)"
                        >Remover</app-button
                      >
                    }
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="8" class="py-2 text-fg-muted">Sem linhas.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="mt-3 text-end text-sm" data-testid="purchase-totals">
          Líquido {{ money(o.totals.net) }} · Imposto {{ money(o.totals.tax) }} ·
          <strong>Total {{ money(o.totals.total) }} {{ o.currency }}</strong>
        </p>
        @if (o.status === 'DRAFT' && canManage()) {
          <div class="mt-4 grid items-end gap-3 rounded-lg border border-line p-3 sm:grid-cols-5">
            <app-input label="SKU" [ngModel]="sku()" (ngModelChange)="sku.set($event ?? '')" />
            <app-input
              label="Quantidade"
              [ngModel]="quantity()"
              (ngModelChange)="quantity.set($event ?? '')"
            />
            <app-input
              label="Custo unitário"
              [ngModel]="cost()"
              (ngModelChange)="cost.set($event ?? '')"
            />
            <app-input
              label="Taxa (%)"
              [ngModel]="rate()"
              (ngModelChange)="rate.set($event ?? '')"
            />
            <app-button variant="secondary" [loading]="busy()" (click)="addLine()"
              >Adicionar linha</app-button
            >
          </div>
        }
        @if ((o.status === 'ORDERED' || o.status === 'PARTIAL') && canConfirm()) {
          <div class="mt-4 max-w-md">
            <app-input
              label="Motivo do cancelamento"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event ?? '')"
            />
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap gap-2">
          @if (o.status === 'DRAFT' && canConfirm()) {
            <app-button [loading]="busy()" (click)="confirm()">Confirmar</app-button>
          }
          @if (o.status === 'DRAFT' && canManage() && !o.requisitionId) {
            <app-button variant="secondary" [loading]="busy()" (click)="remove()"
              >Apagar rascunho</app-button
            >
          }
          @if ((o.status === 'ORDERED' || o.status === 'PARTIAL') && canConfirm()) {
            <app-button variant="secondary" [loading]="busy()" (click)="cancel()">{{
              o.status === 'PARTIAL' ? 'Cancelar o restante' : 'Cancelar encomenda'
            }}</app-button>
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex justify-end">
        @if (canManage()) {
          <app-button (click)="startNew()">Nova encomenda</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (orders.isLoading() && !orders.hasValue()) {
          <app-loading-state label="A carregar encomendas…" />
        } @else if (orders.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as encomendas">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (orders.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="truck" title="Sem encomendas a fornecedor" />
          } @else {
            <app-table
              caption="Encomendas a fornecedor"
              [columns]="columns"
              [rows]="page.items"
              data-testid="purchase-orders"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                  }
                  @case ('supplier') {
                    {{ supplierName(row.supplierId) }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                  }
                  @case ('total') {
                    {{ money(row.totals.total) }} {{ row.currency }}
                  }
                  @case ('actions') {
                    <app-button size="sm" variant="secondary" (click)="open(row)">Abrir</app-button>
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>
    }
  `,
})
export class PurchasesTab {
  private readonly api = inject(PurchasingApi);
  private readonly orderApi = inject(OrdersApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('purchase.manage'));
  protected readonly canConfirm = computed(() => this.permissions.can('purchase.confirm'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'supplier', label: 'Fornecedor' },
    { key: 'status', label: 'Estado' },
    { key: 'total', label: 'Total', align: 'end' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  private readonly params = () => {
    const tenant = this.tenantId();
    return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
  };
  protected readonly orders = rxResource({
    params: this.params,
    stream: () => this.api.purchases({ limit: 100 }),
  });
  private readonly suppliers = rxResource({
    params: this.params,
    stream: () => this.api.suppliers({ limit: 200 }),
  });

  protected readonly creating = signal(false);
  protected readonly supplierId = signal('');
  protected readonly order = signal<PurchaseDto | null>(null);
  protected readonly sku = signal('');
  protected readonly quantity = signal('1');
  protected readonly cost = signal('');
  protected readonly rate = signal('0');
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected readonly supplierOptions = computed<readonly SelectOption[]>(() =>
    (this.suppliers.hasValue() ? this.suppliers.value().items : [])
      .filter((s) => s.status === 'ACTIVE')
      .map((s) => ({ value: s.id, label: `${s.code} — ${s.partyName}` })),
  );

  protected trim = trimQuantity;
  protected money = formatDecimal;
  protected status = (o: PurchaseDto) => PURCHASE_STATUS[o.status];
  protected loadError = () => purchasingError(this.orders.error(), 'Pedido falhado.');

  protected supplierName(id: string): string {
    const found = (this.suppliers.hasValue() ? this.suppliers.value().items : []).find(
      (s) => s.id === id,
    );
    return found?.partyName ?? id.slice(0, 8);
  }

  private reset(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
  }

  private run<T>(call: Observable<T>, done: (result: T) => void): void {
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: done,
      error: (error: unknown) =>
        this.actionError.set(purchasingError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected startNew(): void {
    this.reset();
    this.supplierId.set('');
    this.creating.set(true);
  }

  protected create(): void {
    this.reset();
    if (!this.supplierId()) return void this.clientError.set('Escolha o fornecedor.');
    this.run(this.api.createPurchase({ supplierId: this.supplierId() }), (created) => {
      this.creating.set(false);
      this.order.set(created);
      this.notice.set('Rascunho criado. Acrescente as linhas e confirme a encomenda.');
      this.reload.update((n) => n + 1);
    });
  }

  protected open(row: PurchaseDto): void {
    this.reset();
    this.run(this.api.purchase(row.id), (full) => this.order.set(full));
  }

  protected close(): void {
    this.order.set(null);
    this.creating.set(false);
    this.reason.set('');
    this.reload.update((n) => n + 1);
  }

  protected addLine(): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    const sku = this.sku().trim();
    if (!sku) return void this.clientError.set('Indique o SKU.');
    if (!isPositiveQuantity(this.quantity().trim())) {
      return void this.clientError.set('Quantidade positiva com até 6 casas.');
    }
    if (!isMoney(this.cost().trim())) return void this.clientError.set('Custo com até 4 casas.');
    if (!isTaxRate(this.rate().trim())) {
      return void this.clientError.set('Taxa em percentagem (até 4 casas).');
    }
    this.run(
      this.orderApi.variantIdBySku(sku).pipe(
        switchMap((variantId) =>
          this.api.addPurchaseLine(current.id, {
            variantId,
            quantity: this.quantity().trim(),
            unitCost: this.cost().trim(),
            taxRate: this.rate().trim(),
          }),
        ),
      ),
      (updated) => {
        this.order.set(updated);
        this.sku.set('');
        this.cost.set('');
      },
    );
  }

  protected removeLine(lineId: string): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    this.run(this.api.removePurchaseLine(current.id, lineId), (updated) => this.order.set(updated));
  }

  protected confirm(): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    this.run(this.api.confirmPurchase(current.id), (result) => {
      this.order.set(result.order);
      this.notice.set(
        result.idempotent
          ? 'A encomenda já estava confirmada.'
          : `Encomenda ${result.order.number} confirmada.`,
      );
      this.reload.update((n) => n + 1);
    });
  }

  protected cancel(): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    if (!this.reason().trim())
      return void this.clientError.set('Indique o motivo do cancelamento.');
    this.run(this.api.cancelPurchase(current.id, this.reason().trim()), (result) => {
      this.order.set(result.order);
      this.reason.set('');
      this.notice.set(
        current.status === 'PARTIAL'
          ? 'Restante cancelado: as recepções lançadas e o stock mantêm-se.'
          : 'Encomenda cancelada.',
      );
      this.reload.update((n) => n + 1);
    });
  }

  protected remove(): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    this.run(this.api.deletePurchase(current.id), () => {
      this.order.set(null);
      this.notice.set('Rascunho apagado.');
      this.reload.update((n) => n + 1);
    });
  }
}
