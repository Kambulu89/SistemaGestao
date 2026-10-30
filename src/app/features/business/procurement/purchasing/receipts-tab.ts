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
import { remainingQuantity, withinQuantity } from '../../sales/orders/orders-model';
import {
  PurchasingApi,
  type NewReceiptLine,
  type PurchaseDto,
  type ReceiptDto,
} from './purchasing.api';
import {
  isIsoDate,
  PURCHASE_STATUS,
  purchasingError,
  RECEIPT_STATUS,
  trimQuantity,
} from './purchasing-model';

interface LineEntry {
  quantity: string;
  lotCode: string;
  expiresOn: string;
}

/**
 * Recepções (M06): entregam parte (ou a totalidade) de uma encomenda confirmada. Lançar dá entrada do stock ao custo da
 * encomenda; reverter tira-o (e falha se já foi consumido). O saldo por linha e a entrada são do servidor.
 */
@Component({
  selector: 'app-purchasing-receipts',
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
        <h2 class="mb-4 text-base font-semibold">Nova recepção</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <app-select
            label="Encomenda"
            placeholder="Escolha a encomenda a receber"
            [required]="true"
            [options]="orderOptions()"
            [ngModel]="orderId()"
            (ngModelChange)="chooseOrder($event ?? '')"
          />
          <app-select
            label="Armazém"
            placeholder="Escolha o armazém"
            [options]="warehouseOptions()"
            [ngModel]="warehouseId()"
            (ngModelChange)="warehouseId.set($event ?? '')"
          />
          <app-input
            label="Documento do fornecedor"
            [ngModel]="supplierDocument()"
            (ngModelChange)="supplierDocument.set($event ?? '')"
          />
        </div>
        @if (target(); as o) {
          <div class="mt-4 overflow-x-auto">
            <table class="w-full text-sm" data-testid="receive-lines">
              <thead>
                <tr class="text-left text-fg-muted">
                  <th class="py-1 pe-3">Artigo</th>
                  <th class="py-1 pe-3 text-end">Encomendada</th>
                  <th class="py-1 pe-3 text-end">Recebida</th>
                  <th class="py-1 pe-3 text-end">Por receber</th>
                  <th class="py-1 w-32">A receber agora</th>
                  <th class="py-1 w-32">Lote</th>
                  <th class="py-1 w-36">Validade</th>
                </tr>
              </thead>
              <tbody>
                @for (line of o.lines ?? []; track line.id) {
                  <tr class="border-t border-line">
                    <td class="py-2 pe-3">{{ line.description }}</td>
                    <td class="py-2 pe-3 text-end">{{ trim(line.quantity) }}</td>
                    <td class="py-2 pe-3 text-end">{{ trim(line.receivedQty ?? '0') }}</td>
                    <td class="py-2 pe-3 text-end">
                      {{ trim(left(line.quantity, line.receivedQty)) }}
                    </td>
                    @if (left(line.quantity, line.receivedQty) !== '0') {
                      <td class="py-2 pe-2">
                        <input
                          class="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm"
                          [attr.aria-label]="'Quantidade de ' + line.description"
                          [value]="entries()[line.id]?.quantity ?? ''"
                          (input)="setEntry(line.id, 'quantity', $any($event.target).value)"
                        />
                      </td>
                      <td class="py-2 pe-2">
                        <input
                          class="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm"
                          [attr.aria-label]="'Lote de ' + line.description"
                          [value]="entries()[line.id]?.lotCode ?? ''"
                          (input)="setEntry(line.id, 'lotCode', $any($event.target).value)"
                        />
                      </td>
                      <td class="py-2">
                        <input
                          class="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm"
                          placeholder="AAAA-MM-DD"
                          [attr.aria-label]="'Validade de ' + line.description"
                          [value]="entries()[line.id]?.expiresOn ?? ''"
                          (input)="setEntry(line.id, 'expiresOn', $any($event.target).value)"
                        />
                      </td>
                    } @else {
                      <td colspan="3" class="py-2">—</td>
                    }
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
    } @else if (receipt(); as r) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ r.number ?? 'Recepção em rascunho' }}
            <app-badge class="ms-2" [tone]="status(r).tone">{{ status(r).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted">
            Encomenda {{ orderNumber(r.purchaseOrderId) }}
            @if (r.receivedAt) {
              · lançada em {{ r.receivedAt | date: 'dd/MM/yyyy HH:mm' }}
            }
          </span>
        </div>
        @if (r.status === 'REVERSED') {
          <p class="mt-3 text-sm text-fg-muted">Revertida: {{ r.reverseReason }}</p>
        }
        <ul class="mt-4 divide-y divide-line" data-testid="receipt-lines">
          @for (line of r.lines ?? []; track line.id) {
            <li class="flex items-center justify-between py-2 text-sm">
              <span
                >{{ lineName(line.purchaseLineId) }}
                @if (line.lotCode) {
                  <span class="text-fg-muted"> · lote {{ line.lotCode }}</span>
                }
              </span>
              <strong>{{ trim(line.quantity) }}</strong>
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem linhas.</li>
          }
        </ul>
        @if (r.status === 'POSTED' && canPost()) {
          <div class="mt-4 max-w-md">
            <app-input
              label="Motivo da reversão"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event ?? '')"
            />
          </div>
        }
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap gap-2">
          @if (r.status === 'DRAFT' && canPost()) {
            <app-button [loading]="busy()" (click)="post()">Lançar</app-button>
          }
          @if (r.status === 'DRAFT' && canManage()) {
            <app-button variant="secondary" [loading]="busy()" (click)="remove()"
              >Apagar rascunho</app-button
            >
          }
          @if (r.status === 'POSTED' && canPost()) {
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
          <app-button (click)="startNew()">Nova recepção</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (receipts.isLoading() && !receipts.hasValue()) {
          <app-loading-state label="A carregar recepções…" />
        } @else if (receipts.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as recepções">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (receipts.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="truck" title="Sem recepções" />
          } @else {
            <app-table
              caption="Recepções"
              [columns]="columns"
              [rows]="page.items"
              data-testid="receipts"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                  }
                  @case ('order') {
                    {{ orderNumber(row.purchaseOrderId) }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                  }
                  @case ('date') {
                    {{ row.receivedAt ? (row.receivedAt | date: 'dd/MM/yyyy') : '—' }}
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
export class ReceiptsTab {
  private readonly api = inject(PurchasingApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('receipt.manage'));
  protected readonly canPost = computed(() => this.permissions.can('receipt.post'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'order', label: 'Encomenda' },
    { key: 'status', label: 'Estado' },
    { key: 'date', label: 'Lançada em' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  private readonly params = () => {
    const tenant = this.tenantId();
    return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
  };
  protected readonly receipts = rxResource({
    params: this.params,
    stream: () => this.api.receipts({ limit: 100 }),
  });
  private readonly orders = rxResource({
    params: this.params,
    stream: () => this.api.purchases({ limit: 200 }),
  });
  private readonly warehouses = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.api.warehouses(),
  });

  protected readonly creating = signal(false);
  protected readonly orderId = signal('');
  protected readonly warehouseId = signal('');
  protected readonly supplierDocument = signal('');
  protected readonly target = signal<PurchaseDto | null>(null);
  protected readonly entries = signal<Readonly<Record<string, LineEntry>>>({});
  protected readonly receipt = signal<ReceiptDto | null>(null);
  /** A encomenda da recepção aberta (para dar nome às linhas). */
  private readonly receiptOrder = signal<PurchaseDto | null>(null);
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected readonly orderOptions = computed<readonly SelectOption[]>(() =>
    (this.orders.hasValue() ? this.orders.value().items : [])
      .filter((o) => o.status === 'ORDERED' || o.status === 'PARTIAL')
      .map((o) => ({ value: o.id, label: `${o.number} — ${PURCHASE_STATUS[o.status].label}` })),
  );
  protected readonly warehouseOptions = computed<readonly SelectOption[]>(() =>
    (this.warehouses.hasValue() ? this.warehouses.value() : [])
      .filter((w) => !this.target() || w.organizationId === this.target()?.organizationId)
      .map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
  );

  protected trim = trimQuantity;
  protected status = (r: ReceiptDto) => RECEIPT_STATUS[r.status];
  protected loadError = () => purchasingError(this.receipts.error(), 'Pedido falhado.');

  protected left(ordered: string, received: string | undefined): string {
    return remainingQuantity(ordered, received ?? '0');
  }

  protected orderNumber(id: string): string {
    const found = (this.orders.hasValue() ? this.orders.value().items : []).find(
      (o) => o.id === id,
    );
    return found?.number ?? id.slice(0, 8);
  }

  protected lineName(purchaseLineId: string): string {
    return (
      this.receiptOrder()?.lines?.find((l) => l.id === purchaseLineId)?.description ??
      purchaseLineId.slice(0, 8)
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
        this.actionError.set(purchasingError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected startNew(): void {
    this.reset();
    this.orderId.set('');
    this.warehouseId.set('');
    this.supplierDocument.set('');
    this.target.set(null);
    this.entries.set({});
    this.creating.set(true);
  }

  protected chooseOrder(id: string): void {
    this.orderId.set(id);
    this.target.set(null);
    this.entries.set({});
    if (!id) return;
    this.run(this.api.purchase(id), (order) => {
      this.target.set(order);
      // Por omissão recebe-se tudo o que falta.
      this.entries.set(
        Object.fromEntries(
          (order.lines ?? [])
            .map((l) => [l.id, this.left(l.quantity, l.receivedQty)] as const)
            .filter(([, left]) => left !== '0')
            .map(([lineId, left]) => [lineId, { quantity: left, lotCode: '', expiresOn: '' }]),
        ),
      );
    });
  }

  protected setEntry(lineId: string, field: keyof LineEntry, value: string): void {
    this.entries.update((all) => ({
      ...all,
      [lineId]: { quantity: '', lotCode: '', expiresOn: '', ...all[lineId], [field]: value },
    }));
  }

  protected create(): void {
    this.reset();
    const order = this.target();
    if (!order) return void this.clientError.set('Escolha a encomenda.');
    const lines: NewReceiptLine[] = [];
    for (const line of order.lines ?? []) {
      const entry = this.entries()[line.id];
      const quantity = (entry?.quantity ?? '').trim();
      if (quantity === '' || quantity === '0') continue;
      const left = this.left(line.quantity, line.receivedQty);
      if (!withinQuantity(quantity, left)) {
        return void this.clientError.set(
          `«${line.description}»: quantidade positiva até ${trimQuantity(left)}.`,
        );
      }
      const expiresOn = (entry?.expiresOn ?? '').trim();
      if (expiresOn && !isIsoDate(expiresOn)) {
        return void this.clientError.set(`«${line.description}»: validade inválida (AAAA-MM-DD).`);
      }
      const lotCode = (entry?.lotCode ?? '').trim();
      lines.push({
        purchaseLineId: line.id,
        quantity,
        ...(lotCode ? { lotCode } : {}),
        ...(expiresOn ? { expiresOn } : {}),
      });
    }
    if (lines.length === 0) {
      return void this.clientError.set('Indique a quantidade de pelo menos uma linha.');
    }
    this.run(
      this.api.createReceipt({
        purchaseOrderId: order.id,
        warehouseId: this.warehouseId() || null,
        supplierDocument: this.supplierDocument().trim() || null,
        lines,
      }),
      (created) => {
        this.creating.set(false);
        this.receiptOrder.set(order);
        this.receipt.set(created);
        this.notice.set('Rascunho criado. Reveja as linhas e lance a recepção.');
        this.reload.update((n) => n + 1);
      },
    );
  }

  protected open(row: ReceiptDto): void {
    this.reset();
    this.run(this.api.receipt(row.id), (full) =>
      this.run(this.api.purchase(full.purchaseOrderId), (order) => {
        this.receiptOrder.set(order);
        this.receipt.set(full);
      }),
    );
  }

  protected close(): void {
    this.receipt.set(null);
    this.creating.set(false);
    this.reason.set('');
    this.reload.update((n) => n + 1);
  }

  protected post(): void {
    const current = this.receipt();
    if (!current) return;
    this.reset();
    this.run(this.api.postReceipt(current.id), (result) => {
      this.receipt.set(result.receipt);
      this.notice.set(
        result.idempotent
          ? 'A recepção já estava lançada.'
          : `Recepção ${result.receipt.number} lançada: o stock deu entrada.`,
      );
    });
  }

  protected reverse(): void {
    const current = this.receipt();
    if (!current) return;
    this.reset();
    if (!this.reason().trim()) return void this.clientError.set('Indique o motivo da reversão.');
    this.run(this.api.reverseReceipt(current.id, this.reason().trim()), (result) => {
      this.receipt.set(result.receipt);
      this.reason.set('');
      this.notice.set('Recepção revertida: o stock foi retirado e a encomenda reaberta.');
    });
  }

  protected remove(): void {
    const current = this.receipt();
    if (!current) return;
    this.reset();
    this.run(this.api.deleteReceipt(current.id), () => {
      this.receipt.set(null);
      this.notice.set('Rascunho apagado.');
      this.reload.update((n) => n + 1);
    });
  }
}
