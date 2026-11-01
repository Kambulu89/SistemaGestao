import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, map, of, tap, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { Dialog } from '../../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { InventoryApi } from '../stock/inventory.api';
import { VariantDirectory } from '../stock/variant-directory';
import { LogisticsApi, type TransferDto, type TransferStatus } from './logistics.api';
import { isPositiveQty, logisticsError, trimQuantity, TRANSFER_STATUS } from './logistics-model';

interface DraftLine {
  readonly sku: string;
  readonly quantity: string;
}

const STATUS_OPTIONS = (Object.keys(TRANSFER_STATUS) as TransferStatus[]).map((value) => ({
  value,
  label: TRANSFER_STATUS[value].label,
}));

/**
 * Transferências entre armazéns: expedir tira da origem e põe em trânsito; receber põe no destino o que chegou.
 * O stock em trânsito é do armazém técnico e nunca fica «perdido».
 */
@Component({
  selector: 'app-inventory-transfers',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-end gap-3">
      <div class="min-w-48">
        <app-select
          label="Estado"
          placeholder="Todos"
          [options]="statusOptions"
          [ngModel]="status()"
          (ngModelChange)="status.set($event ?? '')"
        />
      </div>
      @if (canManage()) {
        <app-button (click)="openCreate()">Nova transferência</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (transfers.isLoading() && !transfers.hasValue()) {
        <app-loading-state label="A carregar transferências…" />
      } @else if (transfers.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as transferências">
            {{ describe(transfers.error()) }}
          </app-alert>
        </div>
      } @else if (transfers.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="archive" title="Sem transferências" />
        } @else {
          <app-table caption="Transferências" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('number') {
                  <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                }
                @case ('route') {
                  {{ warehouseName(row.sourceWarehouseId) }} →
                  {{ warehouseName(row.destinationWarehouseId) }}
                }
                @case ('status') {
                  <app-badge [tone]="statusOf(row).tone">{{ statusOf(row).label }}</app-badge>
                }
                @case ('actions') {
                  <span class="flex flex-wrap justify-end gap-1">
                    <app-button size="sm" variant="secondary" (click)="show(row)"
                      >Linhas</app-button
                    >
                    @if (canDispatch() && row.status === 'DRAFT') {
                      <app-button size="sm" (click)="dispatch(row)">Expedir</app-button>
                    }
                    @if (canReceive() && canReceiveStatus(row)) {
                      <app-button size="sm" (click)="openReceive(row)">Receber</app-button>
                    }
                    @if (canManage() && row.status === 'DRAFT') {
                      <app-button size="sm" variant="secondary" (click)="remove(row)"
                        >Apagar</app-button
                      >
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (detail.hasValue() && detail.value(); as transfer) {
      <h3 class="mb-2 mt-6 text-sm font-semibold" data-testid="transfer-title">
        Linhas de {{ transfer.number ?? 'rascunho' }}
      </h3>
      <app-card [flush]="true">
        <ul class="divide-y divide-line" data-testid="transfer-lines">
          @for (l of transfer.lines ?? []; track l.id) {
            <li class="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
              <span>{{ directory.label(l.variantId) }}</span>
              <span class="text-fg-muted">
                pedido {{ trim(l.quantity) }} · expedido {{ trim(l.dispatchedQty) }} · recebido
                {{ trim(l.receivedQty) }} · em trânsito {{ trim(l.inTransit) }}
              </span>
            </li>
          }
        </ul>
      </app-card>
    }

    <app-dialog
      [open]="creating()"
      title="Nova transferência"
      [wide]="true"
      (closed)="creating.set(false)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="transfer-form">
        <div class="grid gap-3 sm:grid-cols-2">
          <app-select
            label="Armazém de origem"
            [options]="warehouseOptions()"
            [ngModel]="source()"
            (ngModelChange)="source.set($event ?? '')"
          />
          <app-select
            label="Armazém de destino"
            [options]="warehouseOptions()"
            [ngModel]="destination()"
            (ngModelChange)="destination.set($event ?? '')"
          />
        </div>
        @for (line of lines(); track $index) {
          <div class="flex items-end gap-2">
            <div class="min-w-48 flex-1">
              <app-input
                label="SKU"
                [ngModel]="line.sku"
                (ngModelChange)="editLine($index, { sku: $event ?? '' })"
              />
            </div>
            <div class="w-36">
              <app-input
                label="Quantidade"
                [ngModel]="line.quantity"
                (ngModelChange)="editLine($index, { quantity: $event ?? '' })"
              />
            </div>
            @if (lines().length > 1) {
              <app-button size="sm" variant="secondary" (click)="dropLine($index)"
                >Remover</app-button
              >
            }
          </div>
        }
        <app-button size="sm" variant="secondary" (click)="addLine()">Adicionar linha</app-button>
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="receiving() !== null"
      title="Receber transferência"
      (closed)="receiving.set(null)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="receive-form">
        @for (l of receiveLines(); track l.lineId) {
          <app-input
            [label]="directory.label(l.variantId) + ' (em trânsito ' + trim(l.inTransit) + ')'"
            [ngModel]="l.quantity"
            (ngModelChange)="editReceive(l.lineId, $event ?? '')"
          />
        }
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="receiving.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="receive()">Confirmar recepção</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class TransfersTab {
  private readonly api = inject(LogisticsApi);
  private readonly inventory = inject(InventoryApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;
  protected readonly directory = inject(VariantDirectory);

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly canManage = computed(() => this.permissions.can('transfer.manage'));
  protected readonly canDispatch = computed(() => this.permissions.can('transfer.dispatch'));
  protected readonly canReceive = computed(() => this.permissions.can('transfer.receive'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'route', label: 'Origem → destino' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  protected readonly status = signal('');
  private readonly tick = signal(0);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  protected readonly transfers = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id, status: this.status(), tick: this.tick() } : undefined;
    },
    stream: ({ params }) =>
      this.api.transfers({
        limit: 100,
        ...(params.status ? { status: params.status as TransferStatus } : {}),
      }),
  });
  private readonly warehouses = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id } : undefined;
    },
    stream: () => this.inventory.warehouses(),
  });
  private readonly selectedId = signal<string | null>(null);
  protected readonly detail = rxResource({
    params: () => {
      const id = this.selectedId();
      return id ? { id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) =>
      this.api
        .transfer(params.id)
        .pipe(tap((t) => this.directory.load((t.lines ?? []).map((l) => l.variantId)).subscribe())),
  });

  protected readonly warehouseOptions = computed<readonly SelectOption[]>(() =>
    (this.warehouses.hasValue() ? this.warehouses.value() : [])
      .filter((w) => w.active && !w.technical)
      .map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
  );

  protected readonly creating = signal(false);
  protected readonly source = signal('');
  protected readonly destination = signal('');
  protected readonly lines = signal<readonly DraftLine[]>([{ sku: '', quantity: '' }]);

  protected readonly receiving = signal<TransferDto | null>(null);
  protected readonly receiveLines = signal<
    readonly { lineId: string; variantId: string; inTransit: string; quantity: string }[]
  >([]);

  protected trim = trimQuantity;
  protected describe = (e: unknown) => logisticsError(e, 'Pedido falhado.');
  protected statusOf = (t: TransferDto) => TRANSFER_STATUS[t.status];
  protected canReceiveStatus = (t: TransferDto) =>
    t.status === 'DISPATCHED' || t.status === 'PARTIAL_RECEIVED';

  protected warehouseName(id: string): string {
    const found = (this.warehouses.hasValue() ? this.warehouses.value() : []).find(
      (w) => w.id === id,
    );
    return found ? found.name : id.slice(0, 8);
  }

  protected show(t: TransferDto): void {
    this.selectedId.set(t.id);
  }

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.source.set('');
    this.destination.set('');
    this.lines.set([{ sku: '', quantity: '' }]);
    this.creating.set(true);
  }

  protected editLine(index: number, patch: Partial<DraftLine>): void {
    this.lines.update((all) => all.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  protected addLine(): void {
    this.lines.update((all) => [...all, { sku: '', quantity: '' }]);
  }

  protected dropLine(index: number): void {
    this.lines.update((all) => all.filter((_, i) => i !== index));
  }

  protected create(): void {
    const drafts = this.lines().filter((l) => l.sku.trim() || l.quantity.trim());
    if (!this.source() || !this.destination()) {
      this.formError.set('Escolha o armazém de origem e o de destino.');
      return;
    }
    if (drafts.length === 0 || drafts.some((l) => !l.sku.trim() || !isPositiveQty(l.quantity))) {
      this.formError.set('Cada linha precisa de um SKU e de uma quantidade positiva.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    forkJoin(
      drafts.map((l) =>
        this.inventory.variantBySku(l.sku).pipe(
          map((variant) => ({ variantId: variant.id, quantity: l.quantity.trim() })),
          catchError(() => of(null)),
        ),
      ),
    ).subscribe((resolved) => {
      if (resolved.some((r) => r === null)) {
        this.busy.set(false);
        this.formError.set('Há SKUs que não existem no catálogo.');
        return;
      }
      this.api
        .createTransfer({
          sourceWarehouseId: this.source(),
          destinationWarehouseId: this.destination(),
          lines: resolved.filter((r) => r !== null),
        })
        .subscribe({
          next: (created) => {
            this.busy.set(false);
            this.creating.set(false);
            this.notice.set('Transferência criada em rascunho.');
            this.selectedId.set(created.id);
            this.tick.update((n) => n + 1);
          },
          error: (e: unknown) => {
            this.busy.set(false);
            this.formError.set(logisticsError(e, 'Não foi possível criar a transferência.'));
          },
        });
    });
  }

  protected dispatch(t: TransferDto): void {
    this.run(this.api.dispatchTransfer(t.id), 'Transferência expedida: o stock está em trânsito.');
  }

  protected remove(t: TransferDto): void {
    if (this.selectedId() === t.id) this.selectedId.set(null);
    this.run(this.api.deleteTransfer(t.id), 'Rascunho apagado.');
  }

  protected openReceive(t: TransferDto): void {
    this.formError.set(null);
    this.api.transfer(t.id).subscribe({
      next: (full) => {
        const pending = (full.lines ?? []).filter((l) => !/^0(\.0+)?$/.test(l.inTransit));
        this.directory.load(pending.map((l) => l.variantId)).subscribe();
        this.receiveLines.set(
          pending.map((l) => ({
            lineId: l.id,
            variantId: l.variantId,
            inTransit: l.inTransit,
            quantity: trimQuantity(l.inTransit),
          })),
        );
        this.receiving.set(full);
      },
      error: (e: unknown) => this.actionError.set(logisticsError(e, 'Pedido falhado.')),
    });
  }

  protected editReceive(lineId: string, quantity: string): void {
    this.receiveLines.update((all) =>
      all.map((l) => (l.lineId === lineId ? { ...l, quantity } : l)),
    );
  }

  protected receive(): void {
    const transfer = this.receiving();
    if (!transfer) return;
    const lines = this.receiveLines().filter((l) => l.quantity.trim() !== '' && l.quantity !== '0');
    if (lines.length === 0 || lines.some((l) => !isPositiveQty(l.quantity))) {
      this.formError.set('Indique quantidades positivas para o que chegou.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .receiveTransfer(
        transfer.id,
        lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity.trim() })),
      )
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.receiving.set(null);
          this.notice.set('Recepção registada no armazém de destino.');
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(logisticsError(e, 'Não foi possível receber.'));
        },
      });
  }

  private run(call: Observable<unknown>, message: string): void {
    this.notice.set(null);
    this.actionError.set(null);
    call.subscribe({
      next: () => {
        this.notice.set(message);
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.actionError.set(logisticsError(e, 'Não foi possível concluir a operação.'));
        this.tick.update((n) => n + 1);
      },
    });
  }
}
