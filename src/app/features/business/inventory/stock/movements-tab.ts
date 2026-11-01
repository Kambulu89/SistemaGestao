import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
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
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { InventoryApi, type MovementDto } from './inventory.api';
import { inventoryError, KIND_LABEL, sourceLabel, trimQuantity } from './inventory-model';
import { VariantDirectory } from './variant-directory';

const PAGE = 25;

/** O livro de movimentos (só se acrescenta): quem, quanto, de onde veio e a reversão por movimento oposto. */
@Component({
  selector: 'app-inventory-movements',
  imports: [
    DatePipe,
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (variantId(); as id) {
      <p class="mb-3 flex items-center gap-2 text-sm" data-testid="movement-filter">
        Movimentos de <strong>{{ directory.label(id) }}</strong>
        <app-button size="sm" variant="secondary" (click)="cleared.set(id)">Ver todos</app-button>
      </p>
    }
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (movements.isLoading() && !movements.hasValue()) {
        <app-loading-state label="A carregar movimentos…" />
      } @else if (movements.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os movimentos">
            {{ describe(movements.error()) }}
          </app-alert>
        </div>
      } @else if (movements.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="archive" title="Sem movimentos" />
        } @else {
          <app-table caption="Movimentos de stock" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('postedAt') {
                  {{ row.postedAt | date: 'dd/MM/yyyy HH:mm' }}
                }
                @case ('kind') {
                  <app-badge [tone]="row.kind === 'REVERSAL' ? 'brand' : 'neutral'">{{
                    kindLabel(row.kind)
                  }}</app-badge>
                }
                @case ('variant') {
                  {{ directory.label(row.variantId) }}
                }
                @case ('delta') {
                  <span
                    [class.text-red-600]="row.quantityDelta.startsWith('-')"
                    class="font-medium"
                    >{{ signed(row.quantityDelta) }}</span
                  >
                }
                @case ('cost') {
                  {{ row.unitCost }}
                }
                @case ('source') {
                  {{ source(row.sourceType) }}
                  @if (row.reason) {
                    <span class="block text-xs text-fg-muted">{{ row.reason }}</span>
                  }
                }
                @case ('actions') {
                  @if (canAdjust() && row.kind !== 'REVERSAL') {
                    <span class="flex justify-end">
                      <app-button size="sm" variant="secondary" (click)="ask(row)"
                        >Reverter</app-button
                      >
                    </span>
                  }
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

    <app-dialog
      [open]="reversing() !== null"
      title="Reverter movimento"
      (closed)="reversing.set(null)"
    >
      @if (reversing(); as m) {
        <p class="mb-3 text-sm">
          O livro não se edita: cria-se um movimento oposto de {{ signed(opposite(m)) }} ao custo
          original.
        </p>
      }
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <app-input label="Motivo" [ngModel]="reason()" (ngModelChange)="reason.set($event ?? '')" />
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="reversing.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="confirm()">Reverter</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class MovementsTab {
  private readonly api = inject(InventoryApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;
  protected readonly directory = inject(VariantDirectory);

  /** Variante a mostrar (vem do separador «Stock»); `null` mostra tudo. */
  readonly filterVariantId = input<string | null>(null);

  protected readonly pageSize = PAGE;
  protected readonly canAdjust = computed(() => this.permissions.can('inventory.adjust'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'postedAt', label: 'Data' },
    { key: 'kind', label: 'Tipo' },
    { key: 'variant', label: 'Artigo' },
    { key: 'delta', label: 'Quantidade', align: 'end' },
    { key: 'cost', label: 'Custo', align: 'end' },
    { key: 'source', label: 'Origem' },
    { key: 'actions', label: '', align: 'end' },
  ];

  protected readonly offset = signal(0);
  protected readonly cleared = signal<string | null>(null);
  private readonly tick = signal(0);
  protected readonly variantId = computed(() => {
    const id = this.filterVariantId();
    return id && id !== this.cleared() ? id : null;
  });

  protected readonly movements = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? {
            tenantId: tenant.id,
            variantId: this.variantId(),
            offset: this.offset(),
            tick: this.tick(),
          }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.movements({
        limit: PAGE,
        offset: params.offset,
        ...(params.variantId ? { variantId: params.variantId } : {}),
      }),
  });

  protected readonly reversing = signal<MovementDto | null>(null);
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const ids = [
        ...(this.movements.hasValue() ? this.movements.value().items.map((m) => m.variantId) : []),
      ];
      const filter = this.variantId();
      if (filter) ids.push(filter);
      this.directory.load(ids).subscribe();
    });
  }

  protected kindLabel = (kind: MovementDto['kind']) => KIND_LABEL[kind];
  protected source = sourceLabel;
  protected describe = (e: unknown) => detailedErrorMessage(e, 'Pedido falhado.');

  /** `+5` / `-3`: o sinal explícito, sem passar por `number`. */
  protected signed(value: string): string {
    const text = trimQuantity(value);
    return text.startsWith('-') ? text : `+${text}`;
  }

  protected opposite(m: MovementDto): string {
    return m.quantityDelta.startsWith('-') ? m.quantityDelta.slice(1) : `-${m.quantityDelta}`;
  }

  protected ask(movement: MovementDto): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.formError.set(null);
    this.reason.set('');
    this.reversing.set(movement);
  }

  protected confirm(): void {
    const movement = this.reversing();
    if (!movement) return;
    if (!this.reason().trim()) {
      this.formError.set('Indique o motivo.');
      return;
    }
    this.busy.set(true);
    this.api.reverse(movement.id, this.reason().trim()).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.reversing.set(null);
        this.notice.set(
          result.idempotent ? 'O movimento já estava revertido.' : 'Movimento revertido.',
        );
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formError.set(inventoryError(e, 'Não foi possível reverter.'));
      },
    });
  }
}
