import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
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
import { OrdersApi, type OrderDto, type ShipmentDto } from './orders.api';
import {
  documentError,
  ORDER_STATUS,
  remainingQuantity,
  SHIPMENT_STATUS,
  trimQuantity,
  withinQuantity,
} from './orders-model';

/**
 * Expedições (M04): entregam parte (ou a totalidade) de uma encomenda confirmada. Lançar baixa o stock e entrega a
 * encomenda; reverter repõe-no. O saldo por linha e a baixa são do servidor; aqui só se pedem as quantidades.
 */
@Component({
  selector: 'app-sales-shipments',
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
        <h2 class="mb-4 text-base font-semibold">Nova expedição</h2>
        <app-select
          label="Encomenda"
          placeholder="Escolha a encomenda a expedir"
          [required]="true"
          [options]="orderOptions()"
          [ngModel]="orderId()"
          (ngModelChange)="chooseOrder($event ?? '')"
        />
        @if (target(); as order) {
          <div class="mt-4 overflow-x-auto">
            <table class="w-full text-sm" data-testid="ship-lines">
              <thead>
                <tr class="text-left text-fg-muted">
                  <th class="py-1 pe-3">Artigo</th>
                  <th class="py-1 pe-3 text-end">Encomendada</th>
                  <th class="py-1 pe-3 text-end">Expedida</th>
                  <th class="py-1 pe-3 text-end">Por expedir</th>
                  <th class="py-1 w-40">A expedir agora</th>
                </tr>
              </thead>
              <tbody>
                @for (line of order.lines ?? []; track line.id) {
                  <tr class="border-t border-line">
                    <td class="py-2 pe-3">{{ line.descriptionSnapshot }}</td>
                    <td class="py-2 pe-3 text-end">{{ trim(line.quantity) }}</td>
                    <td class="py-2 pe-3 text-end">{{ trim(line.shippedQty ?? '0') }}</td>
                    <td class="py-2 pe-3 text-end">
                      {{ trim(left(line.quantity, line.shippedQty)) }}
                    </td>
                    <td class="py-2">
                      @if (left(line.quantity, line.shippedQty) !== '0') {
                        <input
                          class="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm"
                          [attr.aria-label]="'Quantidade de ' + line.descriptionSnapshot"
                          [value]="quantities()[line.id] ?? ''"
                          (input)="setQuantity(line.id, $any($event.target).value)"
                        />
                      } @else {
                        —
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (shipment(); as s) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ s.number ?? 'Expedição em rascunho' }}
            <app-badge class="ms-2" [tone]="status(s).tone">{{ status(s).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted">
            Encomenda {{ orderNumber(s.orderId) }}
            @if (s.shippedAt) {
              · lançada em {{ s.shippedAt | date: 'dd/MM/yyyy HH:mm' }}
            }
          </span>
        </div>
        @if (s.status === 'REVERSED') {
          <p class="mt-3 text-sm text-fg-muted">Revertida: {{ s.reverseReason }}</p>
        }
        <ul class="mt-4 divide-y divide-line" data-testid="shipment-lines">
          @for (line of s.lines ?? []; track line.id) {
            <li class="flex items-center justify-between py-2 text-sm">
              <span>{{ lineName(line.orderLineId) }}</span>
              <strong>{{ trim(line.quantity) }}</strong>
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem linhas.</li>
          }
        </ul>
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap items-end gap-2">
          @if (s.status === 'DRAFT' && canPost()) {
            <app-button [loading]="busy()" (click)="post()">Lançar</app-button>
          }
          @if (s.status === 'DRAFT' && canManage()) {
            <app-button variant="secondary" [loading]="busy()" (click)="remove()"
              >Apagar rascunho</app-button
            >
          }
          @if (s.status === 'POSTED' && canPost()) {
            <div class="min-w-56">
              <app-input
                label="Motivo da reversão"
                [ngModel]="reason()"
                (ngModelChange)="reason.set($event ?? '')"
              />
            </div>
            <app-button variant="secondary" [loading]="busy()" (click)="reverse()"
              >Reverter</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex justify-end">
        @if (canManage()) {
          <app-button (click)="startNew()">Nova expedição</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (shipments.isLoading() && !shipments.hasValue()) {
          <app-loading-state label="A carregar expedições…" />
        } @else if (shipments.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as expedições">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (shipments.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="card" title="Sem expedições" />
          } @else {
            <app-table
              caption="Expedições"
              [columns]="columns"
              [rows]="page.items"
              data-testid="shipments"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                  }
                  @case ('order') {
                    {{ orderNumber(row.orderId) }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                  }
                  @case ('date') {
                    {{ row.shippedAt ? (row.shippedAt | date: 'dd/MM/yyyy') : '—' }}
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
export class ShipmentsTab {
  private readonly api = inject(OrdersApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('shipment.manage'));
  protected readonly canPost = computed(() => this.permissions.can('shipment.post'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'order', label: 'Encomenda' },
    { key: 'status', label: 'Estado' },
    { key: 'date', label: 'Lançada em' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  protected readonly shipments = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
    },
    stream: () => this.api.shipments({ limit: 100 }),
  });
  // Encomendas (para o número) e, ao criar, as que ainda se podem expedir.
  private readonly orders = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
    },
    stream: () => this.api.orders({ limit: 200 }),
  });

  protected readonly creating = signal(false);
  protected readonly orderId = signal('');
  protected readonly target = signal<OrderDto | null>(null);
  protected readonly quantities = signal<Readonly<Record<string, string>>>({});
  protected readonly shipment = signal<ShipmentDto | null>(null);
  /** A encomenda da expedição aberta (para dar nome às linhas). */
  private readonly shipmentOrder = signal<OrderDto | null>(null);
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected readonly orderOptions = computed<readonly SelectOption[]>(() =>
    (this.orders.hasValue() ? this.orders.value().items : [])
      .filter((o) => o.status === 'CONFIRMED' || o.status === 'PARTIAL')
      .map((o) => ({ value: o.id, label: `${o.number} — ${ORDER_STATUS[o.status].label}` })),
  );

  protected trim = trimQuantity;
  protected status = (s: ShipmentDto) => SHIPMENT_STATUS[s.status];
  protected loadError = () => documentError(this.shipments.error(), 'Pedido falhado.');

  protected left(ordered: string, shipped: string | undefined): string {
    return remainingQuantity(ordered, shipped ?? '0');
  }

  protected orderNumber(id: string): string {
    const found = (this.orders.hasValue() ? this.orders.value().items : []).find(
      (o) => o.id === id,
    );
    return found?.number ?? id.slice(0, 8);
  }

  protected lineName(orderLineId: string): string {
    return (
      this.shipmentOrder()?.lines?.find((l) => l.id === orderLineId)?.descriptionSnapshot ??
      orderLineId.slice(0, 8)
    );
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
        this.actionError.set(documentError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected startNew(): void {
    this.reset();
    this.orderId.set('');
    this.target.set(null);
    this.quantities.set({});
    this.creating.set(true);
  }

  protected chooseOrder(id: string): void {
    this.orderId.set(id);
    this.target.set(null);
    this.quantities.set({});
    if (!id) return;
    this.run(this.api.order(id), (order) => {
      this.target.set(order);
      // Por omissão expede-se tudo o que falta.
      this.quantities.set(
        Object.fromEntries(
          (order.lines ?? [])
            .map((l) => [l.id, this.left(l.quantity, l.shippedQty)] as const)
            .filter(([, left]) => left !== '0'),
        ),
      );
    });
  }

  protected setQuantity(lineId: string, value: string): void {
    this.quantities.update((q) => ({ ...q, [lineId]: value }));
  }

  protected create(): void {
    this.reset();
    const order = this.target();
    if (!order) return void this.clientError.set('Escolha a encomenda.');
    const lines: { orderLineId: string; quantity: string }[] = [];
    for (const line of order.lines ?? []) {
      const quantity = (this.quantities()[line.id] ?? '').trim();
      if (quantity === '' || quantity === '0') continue;
      if (!withinQuantity(quantity, this.left(line.quantity, line.shippedQty))) {
        return void this.clientError.set(
          `«${line.descriptionSnapshot}»: quantidade positiva até ${trimQuantity(this.left(line.quantity, line.shippedQty))}.`,
        );
      }
      lines.push({ orderLineId: line.id, quantity });
    }
    if (lines.length === 0)
      return void this.clientError.set('Indique a quantidade de pelo menos uma linha.');
    this.run(this.api.createShipment({ orderId: order.id, lines }), (created) => {
      this.creating.set(false);
      this.shipmentOrder.set(order);
      this.shipment.set(created);
      this.notice.set('Rascunho criado. Reveja as linhas e lance a expedição.');
      this.reload.update((n) => n + 1);
    });
  }

  protected open(row: ShipmentDto): void {
    this.reset();
    this.run(this.api.shipment(row.id), (full) =>
      this.run(this.api.order(full.orderId), (order) => {
        this.shipmentOrder.set(order);
        this.shipment.set(full);
      }),
    );
  }

  protected close(): void {
    this.shipment.set(null);
    this.creating.set(false);
    this.reason.set('');
    this.reload.update((n) => n + 1);
  }

  protected post(): void {
    const current = this.shipment();
    if (!current) return;
    this.reset();
    this.run(this.api.postShipment(current.id), (result) => {
      this.shipment.set(result.shipment);
      this.notice.set(
        result.idempotent
          ? 'A expedição já estava lançada.'
          : `Expedição ${result.shipment.number} lançada: o stock foi baixado.`,
      );
    });
  }

  protected reverse(): void {
    const current = this.shipment();
    if (!current) return;
    this.reset();
    if (!this.reason().trim()) return void this.clientError.set('Indique o motivo da reversão.');
    this.run(this.api.reverseShipment(current.id, this.reason().trim()), (result) => {
      this.shipment.set(result.shipment);
      this.reason.set('');
      this.notice.set('Expedição revertida: o stock foi reposto e a encomenda reaberta.');
    });
  }

  protected remove(): void {
    const current = this.shipment();
    if (!current) return;
    this.reset();
    this.run(this.api.deleteShipment(current.id), () => {
      this.shipment.set(null);
      this.notice.set('Rascunho apagado.');
      this.reload.update((n) => n + 1);
    });
  }
}
