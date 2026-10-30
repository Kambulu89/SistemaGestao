import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import {
  CalendarApi,
  type BookingDto,
  type BusyDto,
  type ResourceDto,
  type ResourceType,
} from './calendar.api';
import { addDays, calendarError, formatDateTime, startOfDay } from './calendar-model';

const TYPE_LABEL: Readonly<Record<ResourceType, string>> = {
  ROOM: 'Sala',
  EQUIPMENT: 'Equipamento',
  VEHICLE: 'Veículo',
  OTHER: 'Outro',
};
const TYPE_OPTIONS: readonly SelectOption[] = (Object.keys(TYPE_LABEL) as ResourceType[]).map(
  (value) => ({ value, label: TYPE_LABEL[value] }),
);

/** Salas e equipamentos: capacidade, ocupação e reservas. A colisão de horários impede-se na base de dados. */
@Component({
  selector: 'app-resources-tab',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex items-center justify-between">
      <p class="text-sm text-fg-muted">
        Cada recurso tem a sua capacidade; uma reserva ocupa o intervalo [início, fim) e reservas
        seguidas não colidem.
      </p>
      @if (canManage()) {
        <app-button (click)="openForm(null)">Novo recurso</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (resources.isLoading() && !resources.hasValue()) {
        <app-loading-state label="A carregar recursos…" />
      } @else if (resources.error()) {
        <div class="p-5">
          <app-alert tone="danger">{{ describe(resources.error()) }}</app-alert>
        </div>
      } @else if (list().length === 0) {
        <app-empty-state icon="calendar" title="Sem recursos" />
      } @else {
        <app-table caption="Recursos" [columns]="columns" [rows]="list()">
          <ng-template let-row let-column="column">
            @switch (column.key) {
              @case ('name') {
                <span class="font-medium">{{ row.name }}</span>
                <span class="block text-xs text-fg-muted">{{ row.code }}</span>
              }
              @case ('type') {
                {{ typeName(row.type) }}
              }
              @case ('capacity') {
                {{ row.capacity }}
              }
              @case ('active') {
                <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                  row.active ? 'Activo' : 'Desactivado'
                }}</app-badge>
              }
              @case ('actions') {
                <span class="flex justify-end gap-1">
                  <app-button size="sm" variant="secondary" (click)="openAvailability(row)"
                    >Ocupação</app-button
                  >
                  @if (canManage()) {
                    <app-button size="sm" variant="secondary" (click)="openForm(row)"
                      >Editar</app-button
                    >
                  }
                </span>
              }
            }
          </ng-template>
        </app-table>
      }
    </app-card>

    <app-dialog
      [open]="formOpen()"
      [title]="editing() ? 'Editar recurso' : 'Novo recurso'"
      (closed)="formOpen.set(false)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block" data-testid="resource-error">{{
          text
        }}</app-alert>
      }
      <div class="space-y-3" data-testid="resource-form">
        @if (!editing()) {
          <app-select
            label="Organização"
            [options]="organizationOptions()"
            [ngModel]="organizationId()"
            (ngModelChange)="organizationId.set($event ?? '')"
          />
          <app-input label="Código" [ngModel]="code()" (ngModelChange)="code.set($event ?? '')" />
        }
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <div class="grid gap-3 sm:grid-cols-2">
          <app-select
            label="Tipo"
            [options]="typeOptions"
            [ngModel]="type()"
            (ngModelChange)="type.set(($event ?? 'ROOM') + '')"
          />
          <app-input
            label="Capacidade"
            type="number"
            min="1"
            [ngModel]="capacity()"
            (ngModelChange)="capacity.set(+($event ?? 1) || 1)"
          />
        </div>
        <app-checkbox
          label="Activo (aceita reservas)"
          [ngModel]="active()"
          (ngModelChange)="active.set($event === true)"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="formOpen.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="viewing() !== null"
      [wide]="true"
      [title]="'Ocupação — ' + (viewing()?.name ?? '')"
      (closed)="viewing.set(null)"
    >
      <div class="mb-3 flex items-end gap-2">
        <app-input
          label="A partir de"
          type="date"
          [ngModel]="since()"
          (ngModelChange)="changeSince($event ?? '')"
        />
        <span class="pb-2 text-sm text-fg-muted">próximos 14 dias</span>
      </div>
      @if (busy$.error()) {
        <app-alert tone="danger">{{ describe(busy$.error()) }}</app-alert>
      }
      @if (busy$.hasValue() && busy$.value(); as occupancy) {
        <h3 class="mb-1 text-sm font-semibold">Intervalos ocupados</h3>
        <ul class="mb-4 space-y-1 text-sm" data-testid="busy">
          @for (b of occupancy.busy; track b.id) {
            <li>
              {{ format(b.startsAt) }} → {{ format(b.endsAt) }}
              @if (b.status === 'HELD') {
                <app-badge tone="neutral">Provisória</app-badge>
              }
              @if (b.mine) {
                <app-badge tone="brand">Sua</app-badge>
              }
            </li>
          } @empty {
            <li class="text-fg-muted">Livre neste período.</li>
          }
        </ul>
      }
      @if (bookings.hasValue() && bookings.value(); as booked) {
        <h3 class="mb-1 text-sm font-semibold">Reservas</h3>
        <ul class="space-y-1 text-sm" data-testid="bookings">
          @for (b of booked.items; track b.id) {
            <li class="flex flex-wrap items-center gap-2">
              <span>{{ b.eventTitle ?? 'Evento privado' }} · {{ format(b.startsAt) }}</span>
              @if (canBook()) {
                <button type="button" class="ml-auto text-xs underline" (click)="cancelBooking(b)">
                  Cancelar reserva
                </button>
              }
            </li>
          } @empty {
            <li class="text-fg-muted">Sem reservas.</li>
          }
        </ul>
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="viewing.set(null)">Fechar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class ResourcesTab {
  private readonly api = inject(CalendarApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  protected readonly typeName = (t: ResourceType) => TYPE_LABEL[t];
  protected readonly typeOptions = TYPE_OPTIONS;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Recurso' },
    { key: 'type', label: 'Tipo' },
    { key: 'capacity', label: 'Capacidade', align: 'end' },
    { key: 'active', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];
  protected readonly canManage = computed(() => this.permissions.can('resource.manage'));
  protected readonly canBook = computed(() => this.permissions.can('resource.book'));
  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly resources = rxResource({
    params: () => {
      const t = this.tenant();
      return t ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.resources(),
  });
  protected readonly list = computed<readonly ResourceDto[]>(() =>
    this.resources.hasValue() ? this.resources.value() : [],
  );
  private readonly organizations = rxResource({
    params: () => {
      const t = this.tenant();
      return t && this.canManage() ? { tenantId: t.id } : undefined;
    },
    stream: () => this.api.organizations(),
  });
  protected readonly organizationOptions = computed<readonly SelectOption[]>(() =>
    (this.organizations.hasValue() ? this.organizations.value() : []).map((o) => ({
      value: o.id,
      label: o.name,
    })),
  );

  // --- formulário
  protected readonly formOpen = signal(false);
  protected readonly editing = signal<ResourceDto | null>(null);
  protected readonly organizationId = signal('');
  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly type = signal<string>('ROOM');
  protected readonly capacity = signal(1);
  protected readonly active = signal(true);

  // --- ocupação
  protected readonly viewing = signal<ResourceDto | null>(null);
  protected readonly since = signal(this.todayText());
  protected readonly busy$ = rxResource<
    BusyDto,
    { id: string; from: string; to: string; tick: number } | undefined
  >({
    params: () => {
      const r = this.viewing();
      return r ? { ...this.window(), id: r.id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.availability(params.id, params.from, params.to),
  });
  protected readonly bookings = rxResource({
    params: () => {
      const r = this.viewing();
      return r ? { ...this.window(), id: r.id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.bookings(params.from, params.to, { resourceId: params.id }),
  });

  protected describe = (e: unknown) => calendarError(e, 'Pedido falhado.');
  protected format = (iso: string) => formatDateTime(iso);

  private todayText(): string {
    const d = startOfDay(new Date());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private window(): { from: string; to: string } {
    const [y, m, d] = this.since().split('-').map(Number) as [number, number, number];
    const from = new Date(y, m - 1, d);
    return { from: from.toISOString(), to: addDays(from, 14).toISOString() };
  }

  protected changeSince(value: string): void {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) this.since.set(value);
  }

  protected openForm(resource: ResourceDto | null): void {
    this.formError.set(null);
    this.editing.set(resource);
    this.organizationId.set(this.organizationOptions()[0]?.value ?? '');
    this.code.set(resource?.code ?? '');
    this.name.set(resource?.name ?? '');
    this.type.set(resource?.type ?? 'ROOM');
    this.capacity.set(resource?.capacity ?? 1);
    this.active.set(resource?.active ?? true);
    this.formOpen.set(true);
  }

  private run<T>(call: Observable<T>, message: string, done: () => void): void {
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        done();
        this.notice.set(message);
        this.tick.update((t) => t + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        const text = calendarError(e, 'A operação falhou.');
        if (this.formOpen()) this.formError.set(text);
        else this.actionError.set(text);
      },
    });
  }

  protected save(): void {
    this.formError.set(null);
    this.actionError.set(null);
    const existing = this.editing();
    if (!this.name().trim()) {
      this.formError.set('Indique o nome.');
      return;
    }
    if (existing) {
      this.run(
        this.api.updateResource(existing.id, {
          version: existing.version,
          name: this.name().trim(),
          type: this.type() as ResourceType,
          capacity: this.capacity(),
          active: this.active(),
        }),
        'Recurso actualizado.',
        () => this.formOpen.set(false),
      );
      return;
    }
    this.run(
      this.api.createResource({
        organizationId: this.organizationId(),
        code: this.code().trim(),
        name: this.name().trim(),
        type: this.type() as ResourceType,
        capacity: this.capacity(),
        active: this.active(),
      }),
      'Recurso criado.',
      () => this.formOpen.set(false),
    );
  }

  protected openAvailability(resource: ResourceDto): void {
    this.since.set(this.todayText());
    this.viewing.set(resource);
  }

  protected cancelBooking(booking: BookingDto): void {
    this.run(
      this.api.cancelBooking(booking.id),
      'Reserva cancelada: o evento mantém-se e os participantes foram avisados.',
      () => undefined,
    );
  }
}
