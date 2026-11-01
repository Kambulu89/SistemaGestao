import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { detailedErrorMessage } from '../../../../core/api/error-message';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { InventoryApi, type ReservationDto, type ReservationStatus } from './inventory.api';
import { RESERVATION_LABEL, sourceLabel, trimQuantity } from './inventory-model';
import { VariantDirectory } from './variant-directory';

const STATUS_OPTIONS = (Object.keys(RESERVATION_LABEL) as ReservationStatus[]).map((value) => ({
  value,
  label: RESERVATION_LABEL[value],
}));

/** Reservas de stock: o que está comprometido, por origem, e a libertação do que ficou por consumir. */
@Component({
  selector: 'app-inventory-reservations',
  imports: [FormsModule, Alert, Badge, Button, Card, EmptyState, LoadingState, Select, Table],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-end gap-3">
      <div class="min-w-48">
        <app-select
          label="Estado"
          placeholder="Todos"
          [options]="statusOptions"
          [ngModel]="status()"
          (ngModelChange)="status.set($event ?? ''); offset.set(0)"
        />
      </div>
      @if (canReserve()) {
        <app-button variant="secondary" [loading]="busy()" (click)="expire()"
          >Libertar vencidas</app-button
        >
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (reservations.isLoading() && !reservations.hasValue()) {
        <app-loading-state label="A carregar reservas…" />
      } @else if (reservations.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as reservas">
            {{ describe(reservations.error()) }}
          </app-alert>
        </div>
      } @else if (reservations.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="archive" title="Sem reservas" />
        } @else {
          <app-table caption="Reservas de stock" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('variant') {
                  {{ directory.label(row.variantId) }}
                }
                @case ('source') {
                  {{ source(row.sourceType) }}
                }
                @case ('quantity') {
                  {{ trim(row.quantity) }}
                }
                @case ('consumed') {
                  {{ trim(row.consumedQty) }}
                }
                @case ('released') {
                  {{ trim(row.releasedQty) }}
                }
                @case ('status') {
                  <app-badge [tone]="row.status === 'ACTIVE' ? 'brand' : 'neutral'">{{
                    statusLabel(row.status)
                  }}</app-badge>
                }
                @case ('actions') {
                  @if (canReserve() && row.status === 'ACTIVE') {
                    <span class="flex justify-end">
                      <app-button size="sm" variant="secondary" (click)="release(row)"
                        >Libertar</app-button
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
  `,
})
export class ReservationsTab {
  private readonly api = inject(InventoryApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;
  protected readonly directory = inject(VariantDirectory);

  protected readonly pageSize = 25;
  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly canReserve = computed(() => this.permissions.can('inventory.reserve'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'variant', label: 'Artigo' },
    { key: 'source', label: 'Origem' },
    { key: 'quantity', label: 'Reservado', align: 'end' },
    { key: 'consumed', label: 'Consumido', align: 'end' },
    { key: 'released', label: 'Libertado', align: 'end' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  protected readonly status = signal('');
  protected readonly offset = signal(0);
  private readonly tick = signal(0);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly reservations = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? { tenantId: tenant.id, status: this.status(), offset: this.offset(), tick: this.tick() }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.reservations({
        limit: 25,
        offset: params.offset,
        ...(params.status ? { status: params.status as ReservationStatus } : {}),
      }),
  });

  constructor() {
    effect(() => {
      if (this.reservations.hasValue()) {
        this.directory.load(this.reservations.value().items.map((r) => r.variantId)).subscribe();
      }
    });
  }

  protected trim = trimQuantity;
  protected source = sourceLabel;
  protected statusLabel = (s: ReservationStatus) => RESERVATION_LABEL[s];
  protected describe = (e: unknown) => detailedErrorMessage(e, 'Pedido falhado.');

  protected release(reservation: ReservationDto): void {
    this.run(this.api.release(reservation.id), 'Reserva libertada.');
  }

  protected expire(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    this.api.expireReservations().subscribe({
      next: ({ expired }) => {
        this.busy.set(false);
        this.notice.set(
          expired === 0
            ? 'Não há reservas vencidas.'
            : `${expired} reserva(s) vencida(s) libertada(s).`,
        );
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.actionError.set(detailedErrorMessage(e, 'Não foi possível libertar.'));
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
        this.actionError.set(detailedErrorMessage(e, 'Não foi possível concluir a operação.'));
        this.tick.update((n) => n + 1);
      },
    });
  }
}
