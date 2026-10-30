import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { IamApi } from '../../tenant/data-access/iam.api';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import {
  CalendarApi,
  type CalendarVisibility,
  type EventDetailDto,
  type OccurrenceDto,
} from './calendar.api';
import {
  VIEW_LABEL,
  WEEKDAYS,
  addDays,
  browserZone,
  calendarError,
  dayKey,
  daysIn,
  formatDay,
  formatTime,
  groupByDay,
  isValidZone,
  rangeOf,
  shift,
  startOfDay,
  titleOf,
  type ViewMode,
} from './calendar-model';
import { EventDetail, type PersonOption } from './event-detail';
import { EventEditor } from './event-editor';

const MODES = Object.keys(VIEW_LABEL) as ViewMode[];
const VISIBILITY_OPTIONS: readonly SelectOption[] = [
  { value: 'PRIVATE', label: 'Privado (só eu)' },
  { value: 'TENANT', label: 'Toda a organização' },
];
const MAX_PER_CELL = 3;

/** A agenda em vista de dia, semana ou mês. As ocorrências vêm expandidas do servidor, com as excepções aplicadas. */
@Component({
  selector: 'app-agenda-tab',
  imports: [
    FormsModule,
    Alert,
    Button,
    Dialog,
    EmptyState,
    EventDetail,
    EventEditor,
    Input,
    LoadingState,
    Select,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-end gap-2">
      <div class="flex gap-1" role="group" aria-label="Navegar">
        <app-button size="sm" variant="secondary" (click)="move(-1)" aria-label="Anterior"
          >‹</app-button
        >
        <app-button size="sm" variant="secondary" (click)="today()">Hoje</app-button>
        <app-button size="sm" variant="secondary" (click)="move(1)" aria-label="Seguinte"
          >›</app-button
        >
      </div>
      <h2 class="min-w-40 text-lg font-semibold first-letter:uppercase" data-testid="agenda-title">
        {{ title() }}
      </h2>
      <div class="flex gap-1" role="group" aria-label="Vista">
        @for (m of modes; track m) {
          <app-button
            size="sm"
            [variant]="mode() === m ? 'primary' : 'secondary'"
            [attr.data-testid]="'view-' + m"
            (click)="mode.set(m)"
          >
            {{ viewLabel[m] }}
          </app-button>
        }
      </div>
      <div class="w-56">
        <app-select
          label="Calendário"
          placeholder="Todos"
          [options]="calendarOptions()"
          [ngModel]="calendarFilter()"
          (ngModelChange)="calendarFilter.set($event ?? '')"
        />
      </div>
      <div class="ml-auto flex gap-2">
        @if (canManage()) {
          <app-button variant="secondary" (click)="openCalendar()">Novo calendário</app-button>
          <app-button (click)="newEvent(null)" [disabled]="calendars().length === 0"
            >Novo evento</app-button
          >
        }
      </div>
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (events.isLoading() && !events.hasValue()) {
      <app-loading-state label="A carregar a agenda…" />
    } @else if (events.error()) {
      <app-alert tone="danger">{{ describe(events.error()) }}</app-alert>
    } @else if (calendars().length === 0 && calendarsLoaded()) {
      <app-empty-state icon="calendar" title="Sem calendários" />
    } @else {
      <div class="overflow-x-auto">
        @if (mode() === 'month') {
          <div class="grid min-w-[44rem] grid-cols-7 gap-px text-xs font-medium text-fg-muted">
            @for (d of weekdays; track d.key) {
              <div class="px-1 pb-1">{{ d.short }}</div>
            }
          </div>
        }
        <div
          class="grid gap-px rounded-md border border-line bg-line"
          [class.grid-cols-1]="mode() === 'day'"
          [class.grid-cols-7]="mode() !== 'day'"
          [class.min-w-[44rem]]="mode() !== 'day'"
          [attr.data-testid]="'grid-' + mode()"
        >
          @for (day of days(); track day.getTime()) {
            <div
              class="min-h-24 bg-surface p-1.5 text-sm"
              [class.opacity-60]="mode() === 'month' && day.getMonth() !== anchor().getMonth()"
              [attr.data-testid]="'day-' + key(day)"
            >
              <div class="mb-1 flex items-center justify-between text-xs text-fg-muted">
                <span [class.font-bold]="isToday(day)" [class.text-brand-700]="isToday(day)">
                  {{ mode() === 'month' ? day.getDate() : format(day) }}
                </span>
                @if (canManage()) {
                  <button
                    type="button"
                    class="rounded px-1 hover:bg-surface-muted"
                    [attr.aria-label]="'Novo evento em ' + format(day)"
                    (click)="newEvent(day)"
                  >
                    +
                  </button>
                }
              </div>
              <ul class="space-y-1">
                @for (item of visible(day); track item.eventId + item.startsAt) {
                  <li>
                    <button
                      type="button"
                      class="w-full truncate rounded px-1 py-0.5 text-left"
                      [class]="chip(item)"
                      data-testid="occurrence"
                      [title]="item.title"
                      (click)="open(item)"
                    >
                      @if (!item.allDay) {
                        <span class="font-medium">{{ time(item) }}</span>
                      }
                      {{ item.title }}
                      @if (item.recurring) {
                        <span aria-label="repete-se">↻</span>
                      }
                    </button>
                  </li>
                }
                @if (hidden(day) > 0) {
                  <li class="px-1 text-xs text-fg-muted">+{{ hidden(day) }} mais</li>
                }
              </ul>
            </div>
          }
        </div>
      </div>
      @if (events.hasValue() && events.value(); as shown) {
        <p class="mt-2 text-xs text-fg-muted" data-testid="agenda-fresh">
          {{ shown.items.length }} {{ shown.items.length === 1 ? 'ocorrência' : 'ocorrências' }} ·
          lido em tempo real às {{ shown.asOf.slice(11, 19) }} (UTC) · horas no fuso {{ zone }}
        </p>
      }
    }

    <app-event-detail
      [eventId]="detailId()"
      [occurrence]="detailOccurrence()"
      [resources]="resources.hasValue() ? resources.value() : []"
      [people]="people()"
      (closed)="detailId.set(null)"
      (changed)="changed($event)"
      (edit)="edit($event.event, $event.occurrence)"
    />
    <app-event-editor
      [open]="editing()"
      [calendars]="calendars()"
      [event]="editEvent()"
      [occurrence]="editOccurrence()"
      [suggested]="suggested()"
      (closed)="editing.set(false)"
      (saved)="saved($event)"
    />

    <app-dialog
      [open]="creatingCalendar()"
      title="Novo calendário"
      (closed)="creatingCalendar.set(false)"
    >
      @if (calendarFormError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="calendar-form">
        <app-input label="Nome" [ngModel]="calName()" (ngModelChange)="calName.set($event ?? '')" />
        <app-input
          label="Fuso horário"
          [ngModel]="calZone()"
          (ngModelChange)="calZone.set($event ?? '')"
        />
        <app-select
          label="Visibilidade"
          [options]="visibilityOptions"
          [ngModel]="calVisibility()"
          (ngModelChange)="calVisibility.set(($event ?? 'PRIVATE') + '')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creatingCalendar.set(false)">Cancelar</app-button>
        <app-button (click)="createCalendar()">Criar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class AgendaTab {
  private readonly api = inject(CalendarApi);
  private readonly iam = inject(IamApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  protected readonly modes = MODES;
  protected readonly viewLabel = VIEW_LABEL;
  protected readonly weekdays = WEEKDAYS;
  protected readonly visibilityOptions = VISIBILITY_OPTIONS;
  protected readonly zone = browserZone();
  protected readonly canManage = computed(() => this.permissions.can('calendar.manage'));

  protected readonly mode = signal<ViewMode>('week');
  protected readonly anchor = signal(startOfDay(new Date()));
  protected readonly calendarFilter = signal('');
  protected readonly notice = signal<string | null>(null);
  private readonly tick = signal(0);

  protected readonly range = computed(() => rangeOf(this.mode(), this.anchor()));
  protected readonly days = computed(() => daysIn(this.range()));
  protected readonly title = computed(() => titleOf(this.mode(), this.anchor()));

  protected readonly calendarsRes = rxResource({
    params: () => {
      const t = this.tenant();
      return t ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.calendars(),
  });
  protected readonly calendars = computed(() =>
    this.calendarsRes.hasValue() ? this.calendarsRes.value() : [],
  );
  protected readonly calendarsLoaded = computed(() => this.calendarsRes.hasValue());
  protected readonly calendarOptions = computed<readonly SelectOption[]>(() =>
    this.calendars().map((c) => ({ value: c.id, label: c.name })),
  );

  protected readonly events = rxResource({
    params: () => {
      const t = this.tenant();
      const r = this.range();
      return t
        ? {
            tenantId: t.id,
            from: r.from.toISOString(),
            to: r.to.toISOString(),
            cal: this.calendarFilter(),
            tick: this.tick(),
          }
        : undefined;
    },
    stream: ({ params }) => this.api.events(params.from, params.to, params.cal || undefined),
  });
  protected readonly resources = rxResource({
    params: () => {
      const t = this.tenant();
      return t && this.permissions.can('resource.read') ? { tenantId: t.id } : undefined;
    },
    stream: () => this.api.resources(),
  });
  // Quem pode ser participante; sem permissão de ver membros a lista fica vazia e a agenda continua a funcionar.
  protected readonly members = rxResource({
    params: () => {
      const t = this.tenant();
      return t ? { tenantId: t.id } : undefined;
    },
    stream: () => this.iam.listMembers().pipe(catchError(() => of([]))),
  });
  protected readonly people = computed<readonly PersonOption[]>(() =>
    (this.members.hasValue() ? this.members.value() : [])
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({ membershipId: m.id, label: m.displayName ?? m.email ?? 'Membro' })),
  );

  private readonly byDay = computed(() =>
    groupByDay(this.events.hasValue() ? this.events.value().items : []),
  );

  // --- detalhe e edição
  protected readonly detailId = signal<string | null>(null);
  protected readonly detailOccurrence = signal<OccurrenceDto | null>(null);
  protected readonly editing = signal(false);
  protected readonly editEvent = signal<EventDetailDto | null>(null);
  protected readonly editOccurrence = signal<OccurrenceDto | null>(null);
  protected readonly suggested = signal<Date | null>(null);

  // --- novo calendário
  protected readonly creatingCalendar = signal(false);
  protected readonly calendarFormError = signal<string | null>(null);
  protected readonly calName = signal('');
  protected readonly calZone = signal(browserZone());
  protected readonly calVisibility = signal<string>('PRIVATE');

  protected describe = (e: unknown) => calendarError(e, 'Não foi possível carregar a agenda.');
  protected key = dayKey;
  protected format = formatDay;
  protected time = (item: OccurrenceDto) => formatTime(item.startsAt);
  protected isToday = (d: Date) => dayKey(d) === dayKey(new Date());

  protected visible(day: Date): OccurrenceDto[] {
    const items = this.byDay().get(dayKey(day)) ?? [];
    return this.mode() === 'month' ? items.slice(0, MAX_PER_CELL) : items;
  }

  protected hidden(day: Date): number {
    const total = (this.byDay().get(dayKey(day)) ?? []).length;
    return this.mode() === 'month' ? Math.max(0, total - MAX_PER_CELL) : 0;
  }

  protected chip(item: OccurrenceDto): string {
    return item.status === 'TENTATIVE'
      ? 'bg-surface-muted text-fg-muted border border-dashed border-line'
      : 'bg-brand-50 text-brand-700 hover:bg-brand-100';
  }

  protected move(direction: -1 | 1): void {
    this.anchor.set(shift(this.mode(), this.anchor(), direction));
  }

  protected today(): void {
    this.anchor.set(startOfDay(new Date()));
  }

  protected open(item: OccurrenceDto): void {
    this.detailOccurrence.set(item);
    this.detailId.set(item.eventId);
  }

  protected newEvent(day: Date | null): void {
    this.editEvent.set(null);
    this.editOccurrence.set(null);
    const base = day ? addDays(day, 0) : null;
    if (base) base.setHours(9, 0, 0, 0);
    this.suggested.set(base);
    this.editing.set(true);
  }

  protected edit(event: EventDetailDto, occurrence: OccurrenceDto | null): void {
    this.detailId.set(null);
    this.editEvent.set(event);
    this.editOccurrence.set(occurrence);
    this.editing.set(true);
  }

  protected saved(message: string): void {
    this.editing.set(false);
    this.changed(message);
  }

  protected changed(message: string): void {
    this.notice.set(message);
    this.tick.update((t) => t + 1);
  }

  protected openCalendar(): void {
    this.calendarFormError.set(null);
    this.calName.set('');
    this.calZone.set(browserZone());
    this.calVisibility.set('PRIVATE');
    this.creatingCalendar.set(true);
  }

  protected createCalendar(): void {
    const name = this.calName().trim();
    if (!name) {
      this.calendarFormError.set('Indique o nome.');
      return;
    }
    if (!isValidZone(this.calZone().trim())) {
      this.calendarFormError.set(
        'Fuso horário inválido (use um nome IANA, por exemplo Europe/Lisbon).',
      );
      return;
    }
    this.api
      .createCalendar({
        name,
        timezone: this.calZone().trim(),
        visibility: this.calVisibility() as CalendarVisibility,
      })
      .subscribe({
        next: () => {
          this.creatingCalendar.set(false);
          this.changed('Calendário criado.');
        },
        error: (e: unknown) =>
          this.calendarFormError.set(calendarError(e, 'Não foi possível criar o calendário.')),
      });
  }
}
