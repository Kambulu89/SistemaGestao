import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import { CalendarApi, type BusinessCalendarDto } from './calendar.api';
import { WallClockInput } from './wall-clock-input';
import {
  WEEKDAYS,
  browserZone,
  calendarError,
  formatMinutes,
  formatPeriods,
  fromZonedInput,
  isValidZone,
  parsePeriods,
} from './calendar-model';

/** Horário útil e feriados: a base para prazos e SLA que respeitam o calendário de trabalho. */
@Component({
  selector: 'app-business-hours-tab',
  imports: [
    FormsModule,
    Alert,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Textarea,
    WallClockInput,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex items-center justify-between">
      <p class="text-sm text-fg-muted">
        O horário semanal e os feriados de uma organização, num fuso horário. Os minutos úteis
        excluem feriados e horas fora de trabalho.
      </p>
      @if (canManage()) {
        <app-button (click)="openForm(null)">Novo horário</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (calendars.isLoading() && !calendars.hasValue()) {
      <app-loading-state label="A carregar horários…" />
    } @else if (calendars.error()) {
      <app-alert tone="danger">{{ describe(calendars.error()) }}</app-alert>
    } @else if (list().length === 0) {
      <app-empty-state icon="calendar" title="Sem horários úteis" />
    } @else {
      <div class="grid gap-4 md:grid-cols-2" data-testid="business-list">
        @for (c of list(); track c.id) {
          <app-card [title]="c.name">
            <p class="mb-2 text-xs text-fg-muted">
              {{ c.timezone }} · {{ c.holidays.length }} feriados
            </p>
            <ul class="mb-3 text-sm">
              @for (d of weekdays; track d.key) {
                <li>
                  <span class="inline-block w-10 text-fg-muted">{{ d.short }}</span>
                  {{ periods(c, d.key) || '—' }}
                </li>
              }
            </ul>
            <div class="flex gap-2">
              <app-button size="sm" variant="secondary" (click)="openCalc(c)"
                >Minutos úteis</app-button
              >
              @if (canManage()) {
                <app-button size="sm" variant="secondary" (click)="openForm(c)">Editar</app-button>
                <app-button size="sm" variant="ghost" (click)="remove(c)">Apagar</app-button>
              }
            </div>
          </app-card>
        }
      </div>
    }

    <app-dialog
      [open]="formOpen()"
      [wide]="true"
      [title]="editing() ? 'Editar horário' : 'Novo horário'"
      (closed)="formOpen.set(false)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block" data-testid="business-error">{{
          text
        }}</app-alert>
      }
      <div class="space-y-3" data-testid="business-form">
        @if (!editing()) {
          <app-select
            label="Organização"
            [options]="organizationOptions()"
            [ngModel]="organizationId()"
            (ngModelChange)="organizationId.set($event ?? '')"
          />
        }
        <div class="grid gap-3 sm:grid-cols-2">
          <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
          <app-input
            label="Fuso horário"
            [ngModel]="zone()"
            (ngModelChange)="zone.set($event ?? '')"
          />
        </div>
        <fieldset class="space-y-2">
          <legend class="text-sm font-medium">
            Períodos de trabalho (por exemplo 09:00-12:00, 13:00-17:00)
          </legend>
          @for (d of weekdays; track d.key) {
            <app-input
              [label]="d.label"
              [ngModel]="hours()[d.key] ?? ''"
              (ngModelChange)="setHours(d.key, $event ?? '')"
            />
          }
        </fieldset>
        <app-textarea
          label="Feriados (uma linha por feriado: AAAA-MM-DD Nome)"
          [rows]="4"
          [ngModel]="holidays()"
          (ngModelChange)="holidays.set($event ?? '')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="formOpen.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="calc() !== null"
      [title]="'Minutos úteis — ' + (calc()?.name ?? '')"
      (closed)="calc.set(null)"
    >
      @if (calcError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="calc-form">
        <app-wall-clock
          label="De (hora do horário)"
          [value]="from()"
          (changed)="from.set($event)"
        />
        <app-wall-clock label="Até (hora do horário)" [value]="to()" (changed)="to.set($event)" />
        <app-button size="sm" variant="secondary" (click)="compute()">Calcular</app-button>
        @if (result(); as text) {
          <p class="text-sm" data-testid="working-result">{{ text }}</p>
        }
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="calc.set(null)">Fechar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class BusinessHoursTab {
  private readonly api = inject(CalendarApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  protected readonly weekdays = WEEKDAYS;
  protected readonly canManage = computed(() => this.permissions.can('calendar.manage'));
  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly calendars = rxResource({
    params: () => {
      const t = this.tenant();
      return t ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.businessCalendars(),
  });
  protected readonly list = computed<readonly BusinessCalendarDto[]>(() =>
    this.calendars.hasValue() ? this.calendars.value() : [],
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

  protected readonly formOpen = signal(false);
  protected readonly editing = signal<BusinessCalendarDto | null>(null);
  protected readonly organizationId = signal('');
  protected readonly name = signal('');
  protected readonly zone = signal(browserZone());
  protected readonly hours = signal<Readonly<Record<string, string>>>({});
  protected readonly holidays = signal('');

  protected readonly calc = signal<BusinessCalendarDto | null>(null);
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly result = signal<string | null>(null);
  protected readonly calcError = signal<string | null>(null);

  protected describe = (e: unknown) => calendarError(e, 'Pedido falhado.');
  protected periods = (c: BusinessCalendarDto, key: string) =>
    formatPeriods(c.weeklyWorkingHours[key]);

  protected setHours(key: string, value: string): void {
    this.hours.update((h) => ({ ...h, [key]: value }));
  }

  protected openForm(calendar: BusinessCalendarDto | null): void {
    this.formError.set(null);
    this.editing.set(calendar);
    this.organizationId.set(this.organizationOptions()[0]?.value ?? '');
    this.name.set(calendar?.name ?? '');
    this.zone.set(calendar?.timezone ?? browserZone());
    this.hours.set(
      Object.fromEntries(
        WEEKDAYS.map((d) => [d.key, formatPeriods(calendar?.weeklyWorkingHours[d.key])]),
      ),
    );
    this.holidays.set((calendar?.holidays ?? []).map((h) => `${h.date} ${h.name}`).join('\n'));
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
    if (!this.name().trim()) {
      this.formError.set('Indique o nome.');
      return;
    }
    if (!isValidZone(this.zone().trim())) {
      this.formError.set('Fuso horário inválido (use um nome IANA, por exemplo Europe/Lisbon).');
      return;
    }
    const weekly: Record<string, [string, string][]> = {};
    for (const d of WEEKDAYS) {
      const parsed = parsePeriods(this.hours()[d.key] ?? '');
      if ('error' in parsed) {
        this.formError.set(`${d.label}: ${parsed.error}`);
        return;
      }
      if (parsed.periods.length > 0) weekly[d.key] = parsed.periods;
    }
    const holidays: { date: string; name: string }[] = [];
    for (const line of this.holidays()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      const m = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line);
      if (!m) {
        this.formError.set(`Feriado inválido: «${line}». Use AAAA-MM-DD Nome.`);
        return;
      }
      holidays.push({ date: m[1] as string, name: m[2] as string });
    }
    const existing = this.editing();
    const body = {
      name: this.name().trim(),
      timezone: this.zone().trim(),
      weeklyWorkingHours: weekly,
      holidays,
    };
    this.run(
      existing
        ? this.api.updateBusinessCalendar(existing.id, { version: existing.version, ...body })
        : this.api.createBusinessCalendar({ organizationId: this.organizationId(), ...body }),
      existing ? 'Horário actualizado.' : 'Horário criado.',
      () => this.formOpen.set(false),
    );
  }

  protected remove(calendar: BusinessCalendarDto): void {
    this.actionError.set(null);
    this.run(this.api.deleteBusinessCalendar(calendar.id), 'Horário apagado.', () => undefined);
  }

  protected openCalc(calendar: BusinessCalendarDto): void {
    this.calcError.set(null);
    this.result.set(null);
    this.from.set('');
    this.to.set('');
    this.calc.set(calendar);
  }

  protected compute(): void {
    const calendar = this.calc();
    if (!calendar) return;
    this.calcError.set(null);
    this.result.set(null);
    // As horas escrevem-se no fuso do horário útil, que é o que conta para o trabalho.
    const from = fromZonedInput(this.from(), calendar.timezone);
    const to = fromZonedInput(this.to(), calendar.timezone);
    if (!from || !to) {
      this.calcError.set('Indique as duas datas.');
      return;
    }
    this.api.workingTime(calendar.id, from, to).subscribe({
      next: (r) =>
        this.result.set(
          `${formatMinutes(r.minutes)} úteis (${r.minutes} min) no fuso ${r.timezone}.`,
        ),
      error: (e: unknown) => this.calcError.set(calendarError(e, 'Não foi possível calcular.')),
    });
  }
}
