import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { detailedErrorMessage } from '../../../../core/api/error-message';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { InventoryApi, type VariantInfo } from './inventory.api';
import { isDate } from './inventory-model';

/** Lotes de uma variante com rastreio por lote (código, fabrico e validade). */
@Component({
  selector: 'app-inventory-lots',
  imports: [FormsModule, Alert, Button, Card, EmptyState, Input, LoadingState, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex items-end gap-2">
      <div class="w-64">
        <app-input
          label="SKU da variante"
          [ngModel]="sku()"
          (ngModelChange)="sku.set($event ?? '')"
        />
      </div>
      <app-button variant="secondary" [loading]="searching()" (click)="find()">Procurar</app-button>
    </div>
    @if (error(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (variant(); as v) {
      <p class="mb-3 text-sm" data-testid="lots-variant">
        <strong>{{ v.productName }}</strong> ({{ v.sku }})
        @if (v.trackingMode !== 'LOT') {
          — sem rastreio por lote: não tem lotes.
        }
      </p>
      @if (v.trackingMode === 'LOT') {
        <app-card [flush]="true">
          @if (lots.isLoading() && !lots.hasValue()) {
            <app-loading-state label="A carregar lotes…" />
          } @else if ((lots.value() ?? []).length === 0) {
            <app-empty-state icon="archive" title="Sem lotes" />
          } @else {
            <app-table
              caption="Lotes"
              [columns]="columns"
              [rows]="lots.value() ?? []"
              data-testid="lots"
            >
              <ng-template let-row let-column="column">
                {{ row[column.key] ?? '—' }}
              </ng-template>
            </app-table>
          }
        </app-card>
        @if (canCreate()) {
          <div class="mt-3 flex flex-wrap items-end gap-3" data-testid="lot-form">
            <div class="w-40">
              <app-input
                label="Código"
                [ngModel]="code()"
                (ngModelChange)="code.set($event ?? '')"
              />
            </div>
            <div class="w-44">
              <app-input
                label="Fabrico"
                type="date"
                [ngModel]="made()"
                (ngModelChange)="made.set($event ?? '')"
              />
            </div>
            <div class="w-44">
              <app-input
                label="Validade"
                type="date"
                [ngModel]="expires()"
                (ngModelChange)="expires.set($event ?? '')"
              />
            </div>
            <app-button [loading]="busy()" (click)="create(v)">Criar lote</app-button>
          </div>
        }
      }
    }
  `,
})
export class LotsTab {
  private readonly api = inject(InventoryApi);
  private readonly permissions = inject(PermissionService);

  protected readonly canCreate = computed(() => this.permissions.can('inventory.adjust'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'code', label: 'Lote' },
    { key: 'manufacturedOn', label: 'Fabrico' },
    { key: 'expiresOn', label: 'Validade' },
  ];

  protected readonly sku = signal('');
  protected readonly variant = signal<VariantInfo | null>(null);
  protected readonly searching = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly code = signal('');
  protected readonly made = signal('');
  protected readonly expires = signal('');
  private readonly tick = signal(0);

  protected readonly lots = rxResource({
    params: () => {
      const v = this.variant();
      return v && v.trackingMode === 'LOT' ? { id: v.id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.lots(params.id),
  });

  protected find(): void {
    if (!this.sku().trim()) {
      this.error.set('Indique o SKU.');
      return;
    }
    this.error.set(null);
    this.notice.set(null);
    this.searching.set(true);
    this.api.variantBySku(this.sku()).subscribe({
      next: (variant) => {
        this.searching.set(false);
        this.variant.set(variant);
      },
      error: (e: unknown) => {
        this.searching.set(false);
        this.variant.set(null);
        this.error.set(detailedErrorMessage(e, 'Variante não encontrada.'));
      },
    });
  }

  protected create(variant: VariantInfo): void {
    this.notice.set(null);
    if (!this.code().trim()) {
      this.error.set('Indique o código do lote.');
      return;
    }
    const made = this.made().trim();
    const expires = this.expires().trim();
    if ((made && !isDate(made)) || (expires && !isDate(expires))) {
      this.error.set('As datas têm de ser AAAA-MM-DD.');
      return;
    }
    if (made && expires && expires < made) {
      this.error.set('A validade não pode ser anterior ao fabrico.');
      return;
    }
    this.error.set(null);
    this.busy.set(true);
    this.api
      .createLot({
        variantId: variant.id,
        code: this.code().trim(),
        manufacturedOn: made || null,
        expiresOn: expires || null,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.code.set('');
          this.made.set('');
          this.expires.set('');
          this.notice.set('Lote criado.');
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.error.set(detailedErrorMessage(e, 'Não foi possível criar o lote.'));
        },
      });
  }
}
