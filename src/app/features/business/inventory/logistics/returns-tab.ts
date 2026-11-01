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
import {
  LogisticsApi,
  type ReturnCondition,
  type ReturnDirection,
  type ReturnDto,
  type ReturnStatus,
  type SourceLineDto,
} from './logistics.api';
import {
  CONDITION,
  DIRECTION,
  isPositiveQty,
  logisticsError,
  RETURN_STATUS,
  trimQuantity,
} from './logistics-model';

const STATUS_OPTIONS = (Object.keys(RETURN_STATUS) as ReturnStatus[]).map((value) => ({
  value,
  label: RETURN_STATUS[value].label,
}));
const DIRECTION_OPTIONS = (Object.keys(DIRECTION) as ReturnDirection[]).map((value) => ({
  value,
  label: DIRECTION[value],
}));
const CONDITION_OPTIONS = (Object.keys(CONDITION) as ReturnCondition[]).map((value) => ({
  value,
  label: CONDITION[value],
}));

interface DraftReturnLine {
  readonly quantity: string;
  readonly condition: ReturnCondition;
}

/**
 * Devoluções: a de cliente repõe o que uma expedição lançada tirou; a a fornecedor devolve o que uma recepção deu entrada.
 * O servidor limita cada linha ao que ainda se pode devolver e encaminha o estado (vendável, danificado, quarentena).
 */
@Component({
  selector: 'app-inventory-returns',
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
          label="Sentido"
          placeholder="Todos"
          [options]="directionOptions"
          [ngModel]="direction()"
          (ngModelChange)="direction.set($event ?? '')"
        />
      </div>
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
        <app-button (click)="openCreate()">Nova devolução</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (returns.isLoading() && !returns.hasValue()) {
        <app-loading-state label="A carregar devoluções…" />
      } @else if (returns.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as devoluções">
            {{ describe(returns.error()) }}
          </app-alert>
        </div>
      } @else if (returns.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="archive" title="Sem devoluções" />
        } @else {
          <app-table caption="Devoluções" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('number') {
                  <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                }
                @case ('direction') {
                  {{ directionLabel(row.direction) }}
                }
                @case ('reason') {
                  {{ row.reason }}
                }
                @case ('status') {
                  <app-badge [tone]="statusOf(row).tone">{{ statusOf(row).label }}</app-badge>
                }
                @case ('actions') {
                  <span class="flex flex-wrap justify-end gap-1">
                    <app-button size="sm" variant="secondary" (click)="show(row)"
                      >Linhas</app-button
                    >
                    @if (canPost() && row.status === 'DRAFT') {
                      <app-button size="sm" (click)="approve(row)">Aprovar</app-button>
                    }
                    @if (canPost() && row.status === 'APPROVED') {
                      <app-button size="sm" (click)="post(row)">Lançar</app-button>
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

    @if (detail.hasValue() && detail.value(); as ret) {
      <h3 class="mb-2 mt-6 text-sm font-semibold" data-testid="return-title">
        Linhas de {{ ret.number ?? 'rascunho' }}
      </h3>
      <app-card [flush]="true">
        <ul class="divide-y divide-line" data-testid="return-lines">
          @for (l of ret.lines ?? []; track l.id) {
            <li class="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
              <span>{{ directory.label(l.variantId) }}</span>
              <span class="text-fg-muted">
                {{ trim(l.quantity) }} · {{ conditionLabel(l.condition) }}
              </span>
            </li>
          }
        </ul>
      </app-card>
    }

    <app-dialog
      [open]="creating()"
      title="Nova devolução"
      [wide]="true"
      (closed)="creating.set(false)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="return-form">
        <div class="grid gap-3 sm:grid-cols-2">
          <app-select
            label="Sentido"
            [options]="directionOptions"
            [ngModel]="newDirection()"
            (ngModelChange)="chooseDirection($event ?? 'CUSTOMER')"
          />
          <app-select
            [label]="newDirection() === 'CUSTOMER' ? 'Expedição de origem' : 'Recepção de origem'"
            placeholder="Escolha o documento"
            [options]="documentOptions()"
            [ngModel]="sourceId()"
            (ngModelChange)="chooseSource($event ?? '')"
          />
          <app-select
            label="Armazém que recebe/entrega"
            [options]="warehouseOptions()"
            [ngModel]="warehouse()"
            (ngModelChange)="warehouse.set($event ?? '')"
          />
          <app-input
            label="Motivo"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event ?? '')"
          />
        </div>
        @for (line of sourceLines(); track line.sourceLineId; let i = $index) {
          <div class="flex flex-wrap items-end gap-2" data-testid="source-line">
            <span class="min-w-48 flex-1 text-sm">
              {{ directory.label(line.variantId) }}
              <span class="block text-xs text-fg-muted">
                origem {{ trim(line.quantity) }} · já devolvido {{ trim(line.returned) }} ·
                devolvível
                {{ trim(line.returnable) }}
              </span>
            </span>
            <div class="w-32">
              <app-input
                label="Quantidade"
                [ngModel]="drafts()[i]?.quantity ?? ''"
                (ngModelChange)="editDraft(i, { quantity: $event ?? '' })"
              />
            </div>
            @if (newDirection() === 'CUSTOMER') {
              <div class="w-40">
                <app-select
                  label="Estado"
                  [options]="conditionOptions"
                  [ngModel]="drafts()[i]?.condition ?? 'SELLABLE'"
                  (ngModelChange)="editCondition(i, $event)"
                />
              </div>
            }
          </div>
        }
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class ReturnsTab {
  private readonly api = inject(LogisticsApi);
  private readonly inventory = inject(InventoryApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;
  protected readonly directory = inject(VariantDirectory);

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly directionOptions = DIRECTION_OPTIONS;
  protected readonly conditionOptions = CONDITION_OPTIONS;
  protected readonly canManage = computed(() => this.permissions.can('return.manage'));
  protected readonly canPost = computed(() => this.permissions.can('return.post'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'direction', label: 'Sentido' },
    { key: 'reason', label: 'Motivo' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  protected readonly status = signal('');
  protected readonly direction = signal('');
  private readonly tick = signal(0);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  protected readonly returns = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? {
            tenantId: tenant.id,
            status: this.status(),
            direction: this.direction(),
            tick: this.tick(),
          }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.returns({
        limit: 100,
        ...(params.status ? { status: params.status as ReturnStatus } : {}),
        ...(params.direction ? { direction: params.direction as ReturnDirection } : {}),
      }),
  });
  private readonly warehouses = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant && this.creating() ? { tenantId: tenant.id } : undefined;
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
        .return(params.id)
        .pipe(tap((r) => this.directory.load((r.lines ?? []).map((l) => l.variantId)).subscribe())),
  });

  protected readonly creating = signal(false);
  protected readonly newDirection = signal<ReturnDirection>('CUSTOMER');
  protected readonly sourceId = signal('');
  protected readonly warehouse = signal('');
  protected readonly reason = signal('');
  private readonly documents = signal<readonly { id: string; number: string | null }[]>([]);
  protected readonly sourceLines = signal<readonly SourceLineDto[]>([]);
  protected readonly drafts = signal<readonly DraftReturnLine[]>([]);

  protected readonly documentOptions = computed<readonly SelectOption[]>(() =>
    this.documents().map((d) => ({ value: d.id, label: d.number ?? d.id.slice(0, 8) })),
  );
  protected readonly warehouseOptions = computed<readonly SelectOption[]>(() =>
    (this.warehouses.hasValue() ? this.warehouses.value() : [])
      .filter((w) => w.active && !w.technical)
      .map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
  );

  protected trim = trimQuantity;
  protected describe = (e: unknown) => logisticsError(e, 'Pedido falhado.');
  protected statusOf = (r: ReturnDto) => RETURN_STATUS[r.status];
  protected directionLabel = (d: ReturnDirection) => DIRECTION[d];
  protected conditionLabel = (c: ReturnCondition) => CONDITION[c];

  protected show(r: ReturnDto): void {
    this.selectedId.set(r.id);
  }

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.warehouse.set('');
    this.reason.set('');
    this.creating.set(true);
    this.chooseDirection('CUSTOMER');
  }

  protected chooseDirection(direction: ReturnDirection): void {
    this.newDirection.set(direction);
    this.sourceId.set('');
    this.sourceLines.set([]);
    this.drafts.set([]);
    this.documents.set([]);
    this.api.sourceDocuments(direction).subscribe({
      next: (docs) => this.documents.set(docs),
      error: (e: unknown) =>
        this.formError.set(logisticsError(e, 'Não foi possível listar os documentos.')),
    });
  }

  protected chooseSource(id: string): void {
    this.sourceId.set(id);
    this.sourceLines.set([]);
    this.drafts.set([]);
    if (!id) return;
    this.api.returnSourceLines(this.newDirection(), id).subscribe({
      next: (lines) => {
        this.directory.load(lines.map((l) => l.variantId)).subscribe();
        this.sourceLines.set(lines);
        this.drafts.set(lines.map(() => ({ quantity: '', condition: 'SELLABLE' as const })));
      },
      error: (e: unknown) =>
        this.formError.set(logisticsError(e, 'Não foi possível ler as linhas de origem.')),
    });
  }

  protected editDraft(index: number, patch: Partial<DraftReturnLine>): void {
    this.drafts.update((all) => all.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  protected editCondition(index: number, value: string | null): void {
    const condition = CONDITION_OPTIONS.find((o) => o.value === value)?.value ?? 'SELLABLE';
    this.editDraft(index, { condition });
  }

  protected create(): void {
    if (!this.sourceId() || !this.warehouse() || !this.reason().trim()) {
      this.formError.set('Indique o documento de origem, o armazém e o motivo.');
      return;
    }
    const lines = this.sourceLines().flatMap((line, i) => {
      const draft = this.drafts()[i];
      return draft && draft.quantity.trim() !== '' ? [{ line, draft }] : [];
    });
    if (lines.length === 0 || lines.some(({ draft }) => !isPositiveQty(draft.quantity))) {
      this.formError.set('Indique quantidades positivas para as linhas a devolver.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .createReturn({
        direction: this.newDirection(),
        sourceDocumentId: this.sourceId(),
        warehouseId: this.warehouse(),
        reason: this.reason().trim(),
        lines: lines.map(({ line, draft }) => ({
          sourceLineId: line.sourceLineId,
          quantity: draft.quantity.trim(),
          condition: this.newDirection() === 'CUSTOMER' ? draft.condition : 'SELLABLE',
        })),
      })
      .subscribe({
        next: (created) => {
          this.busy.set(false);
          this.creating.set(false);
          this.notice.set('Devolução criada em rascunho.');
          this.selectedId.set(created.id);
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(logisticsError(e, 'Não foi possível criar a devolução.'));
        },
      });
  }

  protected approve(r: ReturnDto): void {
    this.run(this.api.approveReturn(r.id), 'Devolução aprovada.');
  }

  protected post(r: ReturnDto): void {
    this.run(this.api.postReturn(r.id), 'Devolução lançada: o stock foi movimentado.');
  }

  protected remove(r: ReturnDto): void {
    if (this.selectedId() === r.id) this.selectedId.set(null);
    this.run(this.api.deleteReturn(r.id), 'Rascunho apagado.');
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
