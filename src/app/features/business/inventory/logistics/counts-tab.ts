import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { tap, type Observable } from 'rxjs';
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
import { LogisticsApi, type CountDto, type CountLineDto, type CountStatus } from './logistics.api';
import { COUNT_STATUS, isQty, logisticsError, trimQuantity } from './logistics-model';

const STATUS_OPTIONS = (Object.keys(COUNT_STATUS) as CountStatus[]).map((value) => ({
  value,
  label: COUNT_STATUS[value].label,
}));

/**
 * Inventário físico: abrir congela os locais, contar regista o que se encontrou, rever mostra as diferenças e lançar
 * ajusta o stock por movimentos. Na contagem cega o saldo esperado só aparece na revisão.
 */
@Component({
  selector: 'app-inventory-counts',
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
        <app-button (click)="openCreate()">Nova contagem</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (counts.isLoading() && !counts.hasValue()) {
        <app-loading-state label="A carregar contagens…" />
      } @else if (counts.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as contagens">
            {{ describe(counts.error()) }}
          </app-alert>
        </div>
      } @else if (counts.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="clipboard" title="Sem contagens" />
        } @else {
          <app-table caption="Contagens" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('number') {
                  <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                  @if (row.blind) {
                    <app-badge tone="neutral">Cega</app-badge>
                  }
                }
                @case ('warehouse') {
                  {{ warehouseName(row.warehouseId) }}
                }
                @case ('status') {
                  <app-badge [tone]="statusOf(row).tone">{{ statusOf(row).label }}</app-badge>
                }
                @case ('actions') {
                  <span class="flex flex-wrap justify-end gap-1">
                    <app-button size="sm" variant="secondary" (click)="show(row)"
                      >Linhas</app-button
                    >
                    @if (canManage()) {
                      @if (row.status === 'DRAFT') {
                        <app-button size="sm" (click)="act(row, 'open')">Abrir</app-button>
                        <app-button size="sm" variant="secondary" (click)="act(row, 'remove')"
                          >Apagar</app-button
                        >
                      }
                      @if (row.status === 'OPEN') {
                        <app-button size="sm" (click)="act(row, 'review')"
                          >Enviar para revisão</app-button
                        >
                      }
                      @if (row.status === 'REVIEW') {
                        <app-button size="sm" variant="secondary" (click)="act(row, 'reopen')"
                          >Voltar a contar</app-button
                        >
                      }
                      @if (row.status === 'OPEN' || row.status === 'REVIEW') {
                        <app-button size="sm" variant="secondary" (click)="act(row, 'cancel')"
                          >Cancelar</app-button
                        >
                      }
                    }
                    @if (canPost() && row.status === 'REVIEW') {
                      <app-button size="sm" (click)="act(row, 'post')">Lançar ajustes</app-button>
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (detail.hasValue() && detail.value(); as count) {
      <h3 class="mb-2 mt-6 text-sm font-semibold" data-testid="count-title">
        Linhas de {{ count.number ?? 'rascunho' }} — {{ statusOf(count).label }}
      </h3>
      <app-card [flush]="true">
        <ul class="divide-y divide-line" data-testid="count-lines">
          @for (l of count.lines ?? []; track l.id) {
            <li class="flex flex-wrap items-end justify-between gap-3 px-4 py-2 text-sm">
              <span>
                {{ directory.label(l.variantId) }}
                <span class="block text-xs text-fg-muted">{{
                  locationName(count.warehouseId, l.locationId)
                }}</span>
              </span>
              <span class="flex flex-wrap items-end gap-3">
                @if (l.expectedQty !== null) {
                  <span class="text-fg-muted">esperado {{ trim(l.expectedQty) }}</span>
                }
                @if (count.status === 'OPEN' && canManage()) {
                  <span class="w-28">
                    <app-input
                      label="Contado"
                      [ngModel]="counted(l)"
                      (ngModelChange)="setCounted(l.id, $event ?? '')"
                    />
                  </span>
                } @else if (l.countedQty !== null) {
                  <span>contado {{ trim(l.countedQty) }}</span>
                }
                @if (l.varianceQty !== null) {
                  <app-badge [tone]="isZero(l.varianceQty) ? 'success' : 'warning'"
                    >diferença {{ trim(l.varianceQty) }}</app-badge
                  >
                }
              </span>
            </li>
          }
        </ul>
      </app-card>
      @if (count.status === 'OPEN' && canManage()) {
        <div class="mt-3">
          <app-button [loading]="busy()" (click)="saveCounts(count)">Guardar contagem</app-button>
        </div>
      }
    }

    <app-dialog [open]="creating()" title="Nova contagem" (closed)="creating.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="count-form">
        <app-select
          label="Armazém"
          [options]="warehouseOptions()"
          [ngModel]="warehouse()"
          (ngModelChange)="warehouse.set($event ?? '')"
        />
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" [checked]="blind()" (change)="blind.set(!blind())" />
          Contagem cega (quem conta não vê o saldo esperado)
        </label>
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class CountsTab {
  private readonly api = inject(LogisticsApi);
  private readonly inventory = inject(InventoryApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;
  protected readonly directory = inject(VariantDirectory);

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly canManage = computed(() => this.permissions.can('count.manage'));
  protected readonly canPost = computed(() => this.permissions.can('count.post'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'warehouse', label: 'Armazém' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  protected readonly status = signal('');
  private readonly tick = signal(0);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  protected readonly counts = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant ? { tenantId: tenant.id, status: this.status(), tick: this.tick() } : undefined;
    },
    stream: ({ params }) =>
      this.api.counts({
        limit: 100,
        ...(params.status ? { status: params.status as CountStatus } : {}),
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
      this.api.count(params.id).pipe(
        tap((c) => {
          this.directory.load((c.lines ?? []).map((l) => l.variantId)).subscribe();
          this.loadLocations(c.warehouseId);
        }),
      ),
  });
  private readonly locations = signal<ReadonlyMap<string, string>>(new Map());
  private readonly entered = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly warehouseOptions = computed<readonly SelectOption[]>(() =>
    (this.warehouses.hasValue() ? this.warehouses.value() : [])
      .filter((w) => w.active && !w.technical)
      .map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
  );

  protected readonly creating = signal(false);
  protected readonly warehouse = signal('');
  protected readonly blind = signal(false);

  protected trim = trimQuantity;
  protected describe = (e: unknown) => logisticsError(e, 'Pedido falhado.');
  protected statusOf = (c: CountDto) => COUNT_STATUS[c.status];
  protected isZero = (value: string) => /^-?0(\.0+)?$/.test(value);

  protected warehouseName(id: string): string {
    const found = (this.warehouses.hasValue() ? this.warehouses.value() : []).find(
      (w) => w.id === id,
    );
    return found ? found.name : id.slice(0, 8);
  }

  protected locationName(_warehouseId: string, locationId: string): string {
    return this.locations().get(locationId) ?? locationId.slice(0, 8);
  }

  private loadLocations(warehouseId: string): void {
    this.inventory.warehouse(warehouseId).subscribe({
      next: (w) =>
        this.locations.update(
          (current) =>
            new Map([
              ...current,
              ...(w.locations ?? []).map((l) => [l.id, `${l.code} · ${l.name}`] as const),
            ]),
        ),
      error: () => undefined,
    });
  }

  protected show(c: CountDto): void {
    this.entered.set(new Map());
    this.selectedId.set(c.id);
  }

  protected counted(line: CountLineDto): string {
    return (
      this.entered().get(line.id) ?? (line.countedQty === null ? '' : trimQuantity(line.countedQty))
    );
  }

  protected setCounted(lineId: string, value: string): void {
    this.entered.update((m) => new Map(m).set(lineId, value));
  }

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.warehouse.set('');
    this.blind.set(false);
    this.creating.set(true);
  }

  protected create(): void {
    if (!this.warehouse()) {
      this.formError.set('Escolha o armazém a contar.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api.createCount({ warehouseId: this.warehouse(), blind: this.blind() }).subscribe({
      next: (created) => {
        this.busy.set(false);
        this.creating.set(false);
        this.notice.set('Contagem criada em rascunho. Abra-a para congelar os locais e contar.');
        this.show(created);
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formError.set(logisticsError(e, 'Não foi possível criar a contagem.'));
      },
    });
  }

  protected act(
    c: CountDto,
    action: 'open' | 'review' | 'reopen' | 'post' | 'cancel' | 'remove',
  ): void {
    switch (action) {
      case 'open':
        return this.run(
          this.api.openCount(c.id),
          'Contagem aberta: os locais estão congelados.',
          c,
        );
      case 'review':
        return this.run(this.api.reviewCount(c.id), 'Contagem enviada para revisão.', c);
      case 'reopen':
        return this.run(this.api.reopenCount(c.id), 'Contagem reaberta.', c);
      case 'post':
        return this.run(this.api.postCount(c.id), 'Ajustes lançados e locais descongelados.', c);
      case 'cancel':
        return this.run(
          this.api.cancelCount(c.id, 'Cancelada pelo utilizador'),
          'Contagem cancelada.',
          c,
        );
      case 'remove':
        return this.run(this.api.deleteCount(c.id), 'Rascunho apagado.', null);
    }
  }

  protected saveCounts(count: CountDto): void {
    const lines = [...this.entered()]
      .filter(([, qty]) => qty.trim() !== '')
      .map(([lineId, qty]) => ({ lineId, countedQty: qty.trim() }));
    if (lines.length === 0) {
      this.actionError.set('Indique pelo menos uma quantidade contada.');
      return;
    }
    if (lines.some((l) => !isQty(l.countedQty))) {
      this.actionError.set('As quantidades contadas têm de ser números não negativos.');
      return;
    }
    this.run(this.api.countLines(count.id, lines), 'Contagem guardada.', count);
  }

  private run(call: Observable<unknown>, message: string, keep: CountDto | null): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set(message);
        this.entered.set(new Map());
        this.selectedId.set(keep ? keep.id : null);
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.actionError.set(logisticsError(e, 'Não foi possível concluir a operação.'));
        this.tick.update((n) => n + 1);
      },
    });
  }
}
