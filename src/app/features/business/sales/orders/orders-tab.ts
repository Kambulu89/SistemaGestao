import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { SalesLines, type NewLineRequest } from './lines-editor';
import { OrdersApi, type OrderDto, type OrderStatus } from './orders.api';
import { documentError, formatDecimal, ORDER_STATUS } from './orders-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'number', label: 'Encomenda' },
  { key: 'customer', label: 'Cliente' },
  { key: 'date', label: 'Data' },
  { key: 'total', label: 'Total', align: 'end' },
  { key: 'status', label: 'Estado' },
  { key: 'actions', label: '', align: 'end' },
];

const STATUSES: readonly SelectOption[] = (Object.keys(ORDER_STATUS) as OrderStatus[]).map(
  (value) => ({ value, label: ORDER_STATUS[value].label }),
);

/**
 * Encomendas de venda. Confirmar é o compromisso comercial: **não reserva stock, não expede nem factura** (operações
 * próprias de fatias seguintes); cancelar pede motivo.
 */
@Component({
  selector: 'app-sales-orders',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    Input,
    LoadingState,
    Select,
    SalesLines,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }
    @if (clientError(); as text) {
      <app-alert tone="danger" class="mb-4 block">{{ text }}</app-alert>
    }

    @if (!order() && !creating()) {
      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="min-w-48 flex-1">
          <app-input
            label="Pesquisar"
            placeholder="Número"
            [ngModel]="query()"
            (ngModelChange)="query.set($event ?? '')"
          />
        </div>
        <app-select
          label="Estado"
          placeholder="Todos"
          [options]="statuses"
          [ngModel]="statusFilter()"
          (ngModelChange)="statusFilter.set($event ?? '')"
        />
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
            <app-empty-state icon="card" title="Sem encomendas" />
          } @else {
            <app-table
              caption="Encomendas"
              [columns]="columns"
              [rows]="page.items"
              data-testid="orders"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                    @if (row.quoteId) {
                      <span class="block text-xs text-fg-muted">de proposta</span>
                    }
                  }
                  @case ('customer') {
                    {{ customerName(row.customerId) }}
                  }
                  @case ('date') {
                    {{ row.orderDate }}
                  }
                  @case ('total') {
                    {{ money(row.totals.total) }} {{ row.currency }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row.status).tone">{{
                      status(row.status).label
                    }}</app-badge>
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
    } @else if (creating()) {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">Nova encomenda</h2>
        <app-select
          label="Cliente"
          [required]="true"
          [options]="customerOptions()"
          [ngModel]="customerId()"
          (ngModelChange)="customerId.set($event ?? '')"
        />
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar encomenda</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (order(); as o) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ o.number ?? 'Encomenda em rascunho' }}
            <app-badge class="ms-2" [tone]="status(o.status).tone">{{
              status(o.status).label
            }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted">
            {{ customerName(o.customerId) }} · {{ o.orderDate }} · {{ o.currency }}
          </span>
        </div>
        @if (o.status === 'CONFIRMED') {
          <p class="mt-3 text-sm text-fg-muted">
            Confirmada: o compromisso está registado e o stock fica reservado se a organização tiver
            armazém de vendas. A expedição (separador «Expedições») baixa o stock; a factura é à
            parte.
          </p>
        }
        @if (o.status === 'PARTIAL' || o.status === 'FULFILLED') {
          <p class="mt-3 text-sm text-fg-muted">
            Já tem expedições lançadas: para a desfazer, reverta as expedições.
          </p>
        }
        @if (o.status === 'CANCELLED') {
          <p class="mt-3 text-sm text-fg-muted">Cancelada: {{ o.cancelReason }}</p>
        }
        <div class="mt-4 flex flex-wrap items-end gap-2">
          @if (canConfirm() && o.status === 'DRAFT') {
            <app-button [loading]="busy()" (click)="confirm()">Confirmar</app-button>
          }
          @if (canConfirm() && (o.status === 'DRAFT' || o.status === 'CONFIRMED')) {
            <div class="min-w-56">
              <app-input
                label="Motivo do cancelamento"
                [ngModel]="cancelReason()"
                (ngModelChange)="cancelReason.set($event ?? '')"
              />
            </div>
            <app-button variant="secondary" [loading]="busy()" (click)="cancel()"
              >Cancelar encomenda</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>

      <app-card class="mt-4 block">
        <h3 class="mb-3 text-sm font-semibold">Morada de entrega</h3>
        @if (o.status === 'DRAFT' && canManage()) {
          <div class="grid gap-4 sm:grid-cols-3">
            <app-input
              label="Morada"
              [ngModel]="addressLine()"
              (ngModelChange)="addressLine.set($event ?? '')"
            />
            <app-input
              label="Cidade"
              [ngModel]="addressCity()"
              (ngModelChange)="addressCity.set($event ?? '')"
            />
            <app-input
              label="País (código)"
              [ngModel]="addressCountry()"
              (ngModelChange)="addressCountry.set(($event ?? '').toUpperCase())"
            />
          </div>
          <app-button class="mt-4" variant="secondary" [loading]="busy()" (click)="saveAddress()"
            >Guardar morada</app-button
          >
        } @else {
          <p class="text-sm" data-testid="address">{{ addressText(o) }}</p>
        }
      </app-card>

      <div class="mt-4">
        <app-sales-lines
          [lines]="o.lines ?? []"
          [totals]="o.totals"
          [currency]="o.currency"
          [editable]="canManage() && o.status === 'DRAFT'"
          [busy]="busy()"
          (added)="addLine($event)"
          (removed)="removeLine($event)"
        />
      </div>
    }
  `,
})
export class OrdersTab {
  private readonly api = inject(OrdersApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly statuses = STATUSES;
  protected readonly canManage = computed(() => this.permissions.can('order.manage'));
  protected readonly canConfirm = computed(() => this.permissions.can('sales.confirm'));

  protected readonly query = signal('');
  protected readonly statusFilter = signal('');
  private readonly reload = signal(0);

  protected readonly orders = rxResource({
    params: () => ({ q: this.query().trim(), status: this.statusFilter(), reload: this.reload() }),
    stream: ({ params }) =>
      this.api.orders({ q: params.q || undefined, status: params.status || undefined, limit: 100 }),
  });
  protected readonly loadError = computed(() =>
    documentError(this.orders.error(), 'Tente novamente.'),
  );

  private readonly customers = rxResource({ stream: () => this.api.customers() });
  protected readonly customerOptions = computed<readonly SelectOption[]>(() =>
    (this.customers.hasValue() ? this.customers.value() : []).map((c) => ({
      value: c.id,
      label: `${c.partyName} (${c.code})`,
    })),
  );

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly creating = signal(false);
  protected readonly customerId = signal('');
  protected readonly order = signal<OrderDto | null>(null);
  protected readonly cancelReason = signal('');
  protected readonly addressLine = signal('');
  protected readonly addressCity = signal('');
  protected readonly addressCountry = signal('');

  protected status(status: OrderStatus) {
    return ORDER_STATUS[status];
  }

  protected money(value: string): string {
    return formatDecimal(value);
  }

  protected customerName(id: string): string {
    const list = this.customers.hasValue() ? this.customers.value() : [];
    return list.find((c) => c.id === id)?.partyName ?? '—';
  }

  protected addressText(order: OrderDto): string {
    const a = order.deliveryAddress;
    if (!a) return 'Sem morada de entrega.';
    return [a['line1'], a['city'], a['countryCode']].filter(Boolean).join(', ');
  }

  private reset(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
  }

  private show(order: OrderDto): void {
    this.order.set(order);
    this.addressLine.set(order.deliveryAddress?.['line1'] ?? '');
    this.addressCity.set(order.deliveryAddress?.['city'] ?? '');
    this.addressCountry.set(order.deliveryAddress?.['countryCode'] ?? '');
  }

  private run<T>(call: Observable<T>, done: (result: T) => void): void {
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: done,
      error: (error: unknown) =>
        this.actionError.set(documentError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected startNew(): void {
    this.reset();
    this.customerId.set('');
    this.creating.set(true);
  }

  protected create(): void {
    this.reset();
    const customer = (this.customers.hasValue() ? this.customers.value() : []).find(
      (c) => c.id === this.customerId(),
    );
    if (!customer) return void this.clientError.set('Escolha o cliente.');
    this.run(
      this.api.createOrder({ organizationId: customer.organizationId, customerId: customer.id }),
      (created) => {
        this.creating.set(false);
        this.show(created);
        this.notice.set('Encomenda criada. Acrescente as linhas.');
      },
    );
  }

  protected open(row: OrderDto): void {
    this.reset();
    this.run(this.api.order(row.id), (full) => this.show(full));
  }

  protected close(): void {
    this.order.set(null);
    this.cancelReason.set('');
    this.reload.update((n) => n + 1);
  }

  protected saveAddress(): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    const address: Record<string, string> = {};
    if (this.addressLine().trim()) address['line1'] = this.addressLine().trim();
    if (this.addressCity().trim()) address['city'] = this.addressCity().trim();
    if (this.addressCountry().trim()) address['countryCode'] = this.addressCountry().trim();
    this.run(
      this.api.updateOrder(current.id, current.version, {
        deliveryAddress: Object.keys(address).length > 0 ? address : null,
      }),
      (updated) => {
        this.show({ ...updated, lines: updated.lines ?? current.lines });
        this.notice.set('Morada guardada.');
      },
    );
  }

  protected addLine(request: NewLineRequest): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    this.run(this.api.variantIdBySku(request.sku), (variantId) =>
      this.run(
        this.api.addOrderLine(current.id, {
          variantId,
          quantity: request.quantity,
          ...(request.discountRate ? { discountRate: request.discountRate } : {}),
        }),
        (updated) => this.show(updated),
      ),
    );
  }

  protected removeLine(lineId: string): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    this.run(this.api.removeOrderLine(current.id, lineId), (updated) => this.show(updated));
  }

  protected confirm(): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    this.run(this.api.confirmOrder(current.id), (result) => {
      this.show(result.order);
      this.notice.set(
        result.idempotent
          ? 'A encomenda já estava confirmada.'
          : `Encomenda ${result.order.number} confirmada.`,
      );
    });
  }

  protected cancel(): void {
    const current = this.order();
    if (!current) return;
    this.reset();
    if (!this.cancelReason().trim()) {
      return void this.clientError.set('Indique o motivo do cancelamento.');
    }
    this.run(this.api.cancelOrder(current.id, this.cancelReason().trim()), (result) => {
      this.show(result.order);
      this.cancelReason.set('');
      this.notice.set('Encomenda cancelada.');
    });
  }
}
