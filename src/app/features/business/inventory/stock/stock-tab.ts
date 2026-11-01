import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { detailedErrorMessage } from '../../../../core/api/error-message';
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
import { InventoryApi, type VariantInfo } from './inventory.api';
import { adjustmentIssue, inventoryError, trimQuantity } from './inventory-model';
import { VariantDirectory } from './variant-directory';

const PAGE = 25;

/** Saldos por variante, local e lote (físico, reservado e disponível) e o ajuste de stock. */
@Component({
  selector: 'app-inventory-stock',
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
    <div class="mb-3 flex flex-wrap items-end gap-3" data-testid="stock-filters">
      <div class="min-w-48">
        <app-select
          label="Armazém"
          placeholder="Todos"
          [options]="warehouseOptions()"
          [ngModel]="warehouseId()"
          (ngModelChange)="warehouseId.set($event ?? ''); offset.set(0)"
        />
      </div>
      <div class="pb-2">
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            [checked]="nonZero()"
            (change)="nonZero.set(!nonZero()); offset.set(0)"
          />
          Só com movimento ou reserva
        </label>
      </div>
      @if (canAdjust()) {
        <app-button (click)="openAdjust()">Ajustar stock</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }

    <app-card [flush]="true">
      @if (balances.isLoading() && !balances.hasValue()) {
        <app-loading-state label="A carregar stock…" />
      } @else if (balances.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar o stock">
            {{ describe(balances.error()) }}
          </app-alert>
        </div>
      } @else if (balances.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state
            icon="archive"
            title="Sem stock"
            description="Ainda não há saldos com estes filtros."
          />
        } @else {
          <app-table caption="Saldos de stock" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('variant') {
                  <span class="font-medium">{{ directory.label(row.variantId) }}</span>
                }
                @case ('location') {
                  {{ locationName(row.locationId) }}
                }
                @case ('lot') {
                  @if (row.lotCode) {
                    {{ row.lotCode }}
                    @if (row.expiresOn) {
                      <span class="block text-xs text-fg-muted">validade {{ row.expiresOn }}</span>
                    }
                  } @else {
                    —
                  }
                }
                @case ('onHand') {
                  {{ trim(row.onHand) }}
                }
                @case ('reserved') {
                  {{ trim(row.reserved) }}
                }
                @case ('available') {
                  <app-badge [tone]="row.available.startsWith('-') ? 'danger' : 'neutral'">{{
                    trim(row.available)
                  }}</app-badge>
                }
                @case ('actions') {
                  <span class="flex justify-end">
                    <app-button size="sm" variant="secondary" (click)="history.emit(row.variantId)">
                      Movimentos
                    </app-button>
                  </span>
                }
              }
            </ng-template>
          </app-table>
          <div class="flex items-center justify-between border-t border-line px-4 py-2 text-sm">
            <span class="text-fg-muted"
              >{{ offset() + 1 }}–{{ offset() + page.items.length }} de {{ page.total }}</span
            >
            <span class="flex gap-2">
              <app-button
                size="sm"
                variant="secondary"
                [disabled]="offset() === 0"
                (click)="offset.set(offset() - pageSize)"
                >Anterior</app-button
              >
              <app-button
                size="sm"
                variant="secondary"
                [disabled]="offset() + pageSize >= page.total"
                (click)="offset.set(offset() + pageSize)"
                >Seguinte</app-button
              >
            </span>
          </div>
        }
      }
    </app-card>

    <app-dialog [open]="adjusting()" title="Ajustar stock" (closed)="adjusting.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="adjust-form">
        <div class="flex items-end gap-2">
          <div class="flex-1">
            <app-input
              label="SKU"
              [ngModel]="sku()"
              (ngModelChange)="sku.set($event ?? ''); variant.set(null)"
            />
          </div>
          <app-button variant="secondary" [loading]="searching()" (click)="findVariant()"
            >Procurar</app-button
          >
        </div>
        @if (variant(); as v) {
          <p class="text-sm" data-testid="variant-found">
            <strong>{{ v.productName }}</strong> · {{ trackingText(v) }}
          </p>
        }
        <app-select
          label="Local"
          placeholder="Escolha o local"
          [options]="locationOptions()"
          [ngModel]="locationId()"
          (ngModelChange)="locationId.set($event ?? '')"
        />
        @if (needsLot()) {
          <app-select
            label="Lote"
            placeholder="Escolha o lote"
            [options]="lotOptions()"
            [ngModel]="lotId()"
            (ngModelChange)="lotId.set($event ?? '')"
          />
        }
        <app-input
          label="Quantidade (negativa para uma saída)"
          [ngModel]="delta()"
          (ngModelChange)="delta.set($event ?? '')"
        />
        <app-input
          label="Custo unitário (opcional)"
          hint="Só conta nas entradas; as saídas saem ao custo médio."
          [ngModel]="cost()"
          (ngModelChange)="cost.set($event ?? '')"
        />
        <app-input label="Motivo" [ngModel]="reason()" (ngModelChange)="reason.set($event ?? '')" />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="adjusting.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="submit()">Lançar ajuste</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class StockTab {
  private readonly api = inject(InventoryApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;
  protected readonly directory = inject(VariantDirectory);

  /** Pede à página que mostre os movimentos de uma variante. */
  readonly history = output<string>();

  protected readonly pageSize = PAGE;
  protected readonly canAdjust = computed(() => this.permissions.can('inventory.adjust'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'variant', label: 'Artigo' },
    { key: 'location', label: 'Local' },
    { key: 'lot', label: 'Lote' },
    { key: 'onHand', label: 'Em mão', align: 'end' },
    { key: 'reserved', label: 'Reservado', align: 'end' },
    { key: 'available', label: 'Disponível', align: 'end' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reloadTick = signal(0);
  protected readonly warehouseId = signal('');
  protected readonly nonZero = signal(false);
  protected readonly offset = signal(0);

  private readonly warehouses = rxResource({
    params: () => this.tenantId()?.id,
    stream: () => this.api.warehouses(),
  });
  // Os locais de cada armazém, para dar nome aos saldos e escolher o local no ajuste.
  protected readonly locations = rxResource({
    params: () => (this.warehouses.hasValue() ? this.warehouses.value() : undefined),
    stream: ({ params }) =>
      params.length === 0
        ? of([] as never[])
        : forkJoin(params.map((w) => this.api.warehouse(w.id))),
  });

  protected readonly balances = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? {
            tenantId: tenant.id,
            warehouseId: this.warehouseId(),
            nonZero: this.nonZero(),
            offset: this.offset(),
            reload: this.reloadTick(),
          }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.balances({
        limit: PAGE,
        offset: params.offset,
        ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
        ...(params.nonZero ? { nonZero: true } : {}),
      }),
  });

  protected readonly warehouseOptions = computed<readonly SelectOption[]>(() =>
    (this.warehouses.hasValue() ? this.warehouses.value() : []).map((w) => ({
      value: w.id,
      label: `${w.code} — ${w.name}`,
    })),
  );
  protected readonly locationOptions = computed<readonly SelectOption[]>(() =>
    (this.locations.hasValue() ? this.locations.value() : []).flatMap((w) =>
      (w.locations ?? [])
        .filter((l) => l.active)
        .map((l) => ({ value: l.id, label: `${w.code} / ${l.code} — ${l.name}` })),
    ),
  );

  // --- ajuste ---------------------------------------------------------------------------------
  protected readonly adjusting = signal(false);
  protected readonly sku = signal('');
  protected readonly variant = signal<VariantInfo | null>(null);
  protected readonly locationId = signal('');
  protected readonly lotId = signal('');
  protected readonly delta = signal('');
  protected readonly cost = signal('');
  protected readonly reason = signal('');
  protected readonly searching = signal(false);
  protected readonly busy = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  /** Uma referência por formulário aberto: carregar duas vezes em «Lançar» não duplica o ajuste. */
  private reference = crypto.randomUUID();

  protected readonly lots = rxResource({
    params: () => {
      const v = this.variant();
      return v && v.trackingMode === 'LOT' ? v.id : undefined;
    },
    stream: ({ params }) => this.api.lots(params),
  });
  protected readonly needsLot = computed(() => this.variant()?.trackingMode === 'LOT');
  protected readonly lotOptions = computed<readonly SelectOption[]>(() =>
    (this.lots.hasValue() ? this.lots.value() : []).map((l) => ({
      value: l.id,
      label: l.expiresOn ? `${l.code} (validade ${l.expiresOn})` : l.code,
    })),
  );

  constructor() {
    // Os nomes das variantes vêm do catálogo, uma vez por id.
    effect(() => {
      if (this.balances.hasValue()) {
        this.directory.load(this.balances.value().items.map((b) => b.variantId)).subscribe();
      }
    });
  }

  protected trim = trimQuantity;
  protected describe = (e: unknown) => detailedErrorMessage(e, 'Pedido falhado.');

  protected locationName(id: string): string {
    const all = this.locations.hasValue() ? this.locations.value() : [];
    for (const w of all) {
      const l = w.locations?.find((x) => x.id === id);
      if (l) return `${w.code} / ${l.code}`;
    }
    return id.slice(0, 8);
  }

  protected trackingText(v: VariantInfo): string {
    if (!v.trackStock) return 'sem controlo de stock';
    return v.trackingMode === 'LOT'
      ? 'rastreio por lote'
      : v.trackingMode === 'SERIAL'
        ? 'rastreio por série'
        : 'sem rastreio';
  }

  protected openAdjust(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.sku.set('');
    this.variant.set(null);
    this.locationId.set('');
    this.lotId.set('');
    this.delta.set('');
    this.cost.set('');
    this.reason.set('');
    this.reference = crypto.randomUUID();
    this.adjusting.set(true);
  }

  protected findVariant(): void {
    if (!this.sku().trim()) {
      this.formError.set('Indique o SKU.');
      return;
    }
    this.formError.set(null);
    this.searching.set(true);
    this.api.variantBySku(this.sku()).subscribe({
      next: (variant) => {
        this.searching.set(false);
        this.variant.set(variant);
        this.lotId.set('');
      },
      error: (e: unknown) => {
        this.searching.set(false);
        this.variant.set(null);
        this.formError.set(detailedErrorMessage(e, 'Variante não encontrada.'));
      },
    });
  }

  protected submit(): void {
    const variant = this.variant();
    const issue = adjustmentIssue({
      quantityDelta: this.delta(),
      unitCost: this.cost(),
      reason: this.reason(),
      hasVariant: variant !== null,
      needsLot: this.needsLot(),
      lotId: this.lotId(),
      locationId: this.locationId(),
    });
    if (issue || !variant) {
      this.formError.set(issue);
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .adjust({
        variantId: variant.id,
        locationId: this.locationId(),
        lotId: this.lotId() || null,
        quantityDelta: this.delta().trim(),
        unitCost: this.cost().trim() || null,
        reason: this.reason().trim(),
        reference: this.reference,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.adjusting.set(false);
          this.notice.set('Ajuste lançado.');
          this.reloadTick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(inventoryError(e, 'Não foi possível lançar o ajuste.'));
        },
      });
  }
}
