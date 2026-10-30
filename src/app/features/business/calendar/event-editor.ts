import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { Input } from '../../../shared/ui/input/input';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import { WallClockInput } from './wall-clock-input';
import {
  CalendarApi,
  type CalendarDto,
  type EditScope,
  type EventBody,
  type EventDetailDto,
  type OccurrenceDto,
} from './calendar.api';
import {
  REPEAT_LABEL,
  WEEKDAYS,
  browserZone,
  calendarError,
  formFromRule,
  fromZonedInput,
  isValidZone,
  ruleFromForm,
  toZonedInput,
  type Repeat,
} from './calendar-model';

const REPEAT_OPTIONS: readonly SelectOption[] = (Object.keys(REPEAT_LABEL) as Repeat[]).map(
  (value) => ({ value, label: REPEAT_LABEL[value] }),
);
const SCOPE_OPTIONS: readonly SelectOption[] = [
  { value: 'THIS', label: 'Só esta ocorrência' },
  { value: 'FUTURE', label: 'Esta e as seguintes' },
  { value: 'ALL', label: 'Toda a série' },
];
const STATUS_OPTIONS: readonly SelectOption[] = [
  { value: 'CONFIRMED', label: 'Confirmado' },
  { value: 'TENTATIVE', label: 'Provisório' },
];

const dayOf = (local: string) => local.slice(0, 10);

/**
 * Criar e editar eventos. Num evento que se repete pergunta se a alteração é só desta ocorrência, desta em diante ou
 * de toda a série; as horas escrevem-se no fuso do evento e o servidor guarda instantes.
 */
@Component({
  selector: 'app-event-editor',
  imports: [FormsModule, Alert, Button, Checkbox, Dialog, Input, Select, Textarea, WallClockInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-dialog
      [open]="open()"
      [wide]="true"
      [title]="event() ? 'Editar evento' : 'Novo evento'"
      (closed)="closed.emit()"
    >
      @if (error(); as text) {
        <app-alert tone="danger" class="mb-3 block" data-testid="editor-error">{{
          text
        }}</app-alert>
      }
      <div class="space-y-3" data-testid="event-editor">
        @if (isSeries()) {
          <app-select
            label="O que alterar"
            [options]="scopeOptions"
            [ngModel]="scope()"
            (ngModelChange)="scope.set(($event ?? 'ALL') + '')"
          />
        }
        @if (!event()) {
          <app-select
            label="Calendário"
            [options]="calendarOptions()"
            [ngModel]="calendarId()"
            (ngModelChange)="chooseCalendar($event ?? '')"
          />
        }
        <app-input label="Título" [ngModel]="title()" (ngModelChange)="title.set($event ?? '')" />
        <app-textarea
          label="Descrição"
          [rows]="2"
          [ngModel]="description()"
          (ngModelChange)="description.set($event ?? '')"
        />
        <div class="grid gap-3 sm:grid-cols-2">
          <app-input
            label="Fuso horário"
            [disabled]="timeLocked()"
            [ngModel]="timezone()"
            (ngModelChange)="timezone.set($event ?? '')"
          />
          <app-checkbox
            label="Dia inteiro"
            [disabled]="timeLocked()"
            [ngModel]="allDay()"
            (ngModelChange)="allDay.set($event === true)"
          />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <app-wall-clock
            [label]="allDay() ? 'Primeiro dia' : 'Início'"
            [kind]="allDay() ? 'date' : 'datetime-local'"
            [value]="start()"
            (changed)="start.set($event)"
          />
          <app-wall-clock
            [label]="allDay() ? 'Último dia' : 'Fim'"
            [kind]="allDay() ? 'date' : 'datetime-local'"
            [value]="end()"
            (changed)="end.set($event)"
          />
        </div>
        @if (scope() !== 'THIS') {
          <fieldset class="space-y-2 rounded-md border border-line p-3">
            <legend class="px-1 text-sm font-medium">Repetição</legend>
            <app-select
              label="Repetir"
              [disabled]="repeatLocked()"
              [options]="repeatOptions"
              [ngModel]="repeat()"
              (ngModelChange)="repeat.set(($event ?? 'NONE') + '')"
            />
            @if (repeat() !== 'NONE') {
              <div class="grid gap-3 sm:grid-cols-2">
                <app-input
                  label="De quantos em quantos"
                  type="number"
                  min="1"
                  [ngModel]="interval()"
                  (ngModelChange)="interval.set(+($event ?? 1) || 1)"
                />
                <app-input
                  label="Número de vezes (opcional)"
                  type="number"
                  min="1"
                  [ngModel]="count()"
                  (ngModelChange)="count.set($event ?? '')"
                />
              </div>
              @if (repeat() === 'WEEKLY') {
                <div class="flex flex-wrap gap-3" data-testid="weekdays">
                  @for (day of weekdays; track day.code) {
                    <label class="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        [checked]="days().includes(day.code)"
                        (change)="toggleDay(day.code)"
                      />
                      {{ day.short }}
                    </label>
                  }
                </div>
              }
            }
          </fieldset>
        }
        @if (scope() === 'ALL') {
          <app-select
            label="Estado"
            [options]="statusOptions"
            [ngModel]="status()"
            (ngModelChange)="status.set(($event ?? 'CONFIRMED') + '')"
          />
        }
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="closed.emit()">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class EventEditor {
  private readonly api = inject(CalendarApi);

  readonly open = input(false);
  readonly calendars = input<readonly CalendarDto[]>([]);
  /** A edição de um evento existente (e a ocorrência clicada, se a série se repete). */
  readonly event = input<EventDetailDto | null>(null);
  readonly occurrence = input<OccurrenceDto | null>(null);
  /** Para um evento novo: o início sugerido. */
  readonly suggested = input<Date | null>(null);
  readonly closed = output();
  readonly saved = output<string>();

  protected readonly repeatOptions = REPEAT_OPTIONS;
  protected readonly scopeOptions = SCOPE_OPTIONS;
  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly weekdays = WEEKDAYS;

  protected readonly calendarId = signal('');
  protected readonly title = signal('');
  protected readonly description = signal('');
  protected readonly timezone = signal(browserZone());
  protected readonly allDay = signal(false);
  protected readonly start = signal('');
  protected readonly end = signal('');
  protected readonly repeat = signal<string>('NONE');
  protected readonly interval = signal(1);
  protected readonly count = signal('');
  protected readonly days = signal<readonly string[]>([]);
  protected readonly status = signal<string>('CONFIRMED');
  protected readonly scope = signal<string>('ALL');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly isSeries = computed(() => Boolean(this.event()?.recurrenceRule));
  /** O fuso e «dia inteiro» não mudam a partir de uma ocorrência. */
  protected readonly timeLocked = computed(() => this.event() !== null && this.scope() !== 'ALL');
  /** Repetir só se altera na série toda ou a partir de uma ocorrência. */
  protected readonly repeatLocked = computed(() => false);
  protected readonly calendarOptions = computed<readonly SelectOption[]>(() =>
    this.calendars().map((c) => ({ value: c.id, label: c.name })),
  );

  constructor() {
    effect(() => {
      if (this.open()) this.reset();
    });
    // Mudar o âmbito reescreve as horas: «toda a série» usa o início da série, os outros a ocorrência clicada.
    effect(() => {
      const scope = this.scope();
      const event = this.event();
      if (event && this.open()) this.fillTimes(event, scope);
    });
  }

  private reset(): void {
    const event = this.event();
    this.error.set(null);
    this.busy.set(false);
    if (event) {
      this.calendarId.set(event.calendarId);
      this.title.set(this.occurrence()?.title ?? event.title);
      this.description.set(event.description ?? '');
      this.timezone.set(event.timezone);
      this.allDay.set(event.allDay);
      this.status.set(event.status === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED');
      const form = formFromRule(event.recurrenceRule);
      this.repeat.set(form.repeat);
      this.interval.set(form.interval);
      this.days.set(form.days);
      this.count.set(form.count);
      const scope = event.recurrenceRule && this.occurrence() ? 'THIS' : 'ALL';
      this.scope.set(scope);
      this.fillTimes(event, scope);
      return;
    }
    const first = this.calendars()[0];
    this.calendarId.set(first?.id ?? '');
    this.title.set('');
    this.description.set('');
    this.timezone.set(first?.timezone ?? browserZone());
    this.allDay.set(false);
    this.status.set('CONFIRMED');
    this.repeat.set('NONE');
    this.interval.set(1);
    this.days.set([]);
    this.count.set('');
    this.scope.set('ALL');
    const from = this.suggested() ?? new Date();
    const begin = new Date(from);
    begin.setMinutes(0, 0, 0);
    if (!this.suggested()) begin.setHours(begin.getHours() + 1);
    const finish = new Date(begin.getTime() + 3_600_000);
    this.start.set(toZonedInput(begin.toISOString(), this.timezone()));
    this.end.set(toZonedInput(finish.toISOString(), this.timezone()));
  }

  private fillTimes(event: EventDetailDto, scope: string): void {
    const occurrence = this.occurrence();
    const useOccurrence = scope !== 'ALL' && occurrence !== null;
    const startsAt = useOccurrence ? occurrence.startsAt : event.startsAt;
    const endsAt = useOccurrence ? occurrence.endsAt : event.endsAt;
    const zone = event.timezone;
    if (event.allDay) {
      this.start.set(dayOf(toZonedInput(startsAt, zone)));
      // O servidor guarda o fim exclusivo: o último dia é o anterior.
      this.end.set(
        dayOf(toZonedInput(new Date(new Date(endsAt).getTime() - 1).toISOString(), zone)),
      );
    } else {
      this.start.set(toZonedInput(startsAt, zone));
      this.end.set(toZonedInput(endsAt, zone));
    }
  }

  protected chooseCalendar(id: string): void {
    this.calendarId.set(id);
    const calendar = this.calendars().find((c) => c.id === id);
    if (calendar && !this.event()) this.timezone.set(calendar.timezone);
  }

  protected toggleDay(code: string): void {
    this.days.update((d) => (d.includes(code) ? d.filter((x) => x !== code) : [...d, code]));
  }

  /** Início e fim em instantes, a partir do que se escreveu no fuso do evento. */
  private instants(): { startsAt: string; endsAt: string } | string {
    const zone = this.timezone().trim();
    if (!isValidZone(zone))
      return 'Fuso horário inválido (use um nome IANA, por exemplo Europe/Lisbon).';
    if (this.allDay()) {
      const first = fromZonedInput(`${this.start()}T00:00`, zone);
      const lastDay = new Date(`${this.end()}T00:00:00Z`);
      if (!first || Number.isNaN(lastDay.getTime())) return 'Indique o primeiro e o último dia.';
      lastDay.setUTCDate(lastDay.getUTCDate() + 1);
      const next = fromZonedInput(`${lastDay.toISOString().slice(0, 10)}T00:00`, zone);
      return next ? { startsAt: first, endsAt: next } : 'Datas inválidas.';
    }
    const startsAt = fromZonedInput(this.start(), zone);
    const endsAt = fromZonedInput(this.end(), zone);
    if (!startsAt || !endsAt) return 'Indique o início e o fim.';
    return { startsAt, endsAt };
  }

  protected save(): void {
    this.error.set(null);
    const title = this.title().trim();
    if (!title) {
      this.error.set('Indique o título.');
      return;
    }
    const times = this.instants();
    if (typeof times === 'string') {
      this.error.set(times);
      return;
    }
    const event = this.event();
    const rule = ruleFromForm({
      repeat: this.repeat() as Repeat,
      interval: this.interval(),
      days: this.days(),
      count: this.count(),
    });
    const common = {
      title,
      description: this.description().trim() || null,
      startsAt: times.startsAt,
      endsAt: times.endsAt,
    };
    if (!event) {
      this.run(
        this.api.createEvent({
          ...common,
          calendarId: this.calendarId(),
          timezone: this.timezone().trim(),
          allDay: this.allDay(),
          recurrenceRule: rule,
          status: this.status() as 'TENTATIVE' | 'CONFIRMED',
        }),
        'Evento criado.',
      );
      return;
    }
    const scope = (this.isSeries() ? this.scope() : 'ALL') as EditScope;
    const occurrence = this.occurrence();
    let body: EventBody;
    if (scope === 'THIS') {
      body = {
        version: event.version,
        scope,
        occurrenceStart: occurrence?.occurrenceStart ?? '',
        title,
        ...pick(common, 'startsAt', 'endsAt'),
      };
    } else if (scope === 'FUTURE') {
      const rawRule = event.recurrenceRule ?? null;
      body = {
        version: event.version,
        scope,
        occurrenceStart: occurrence?.occurrenceStart ?? '',
        ...common,
        // Só se envia a regra quando mudou (senão a divisão herda a antiga).
        ...(rule !== rawRule && rule !== reformat(rawRule) ? { recurrenceRule: rule } : {}),
      };
    } else {
      body = {
        version: event.version,
        ...common,
        timezone: this.timezone().trim(),
        allDay: this.allDay(),
        recurrenceRule: rule,
        status: this.status() as 'TENTATIVE' | 'CONFIRMED',
      };
    }
    this.run(this.api.updateEvent(event.id, body), 'Evento actualizado.');
  }

  private run(call: ReturnType<CalendarApi['createEvent']>, message: string): void {
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.saved.emit(message);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(calendarError(e, 'Não foi possível guardar o evento.'));
      },
    });
  }
}

const pick = <T extends object, K extends keyof T>(source: T, ...keys: K[]): Pick<T, K> => {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
};

/** A regra tal como o formulário a reescreveria (para saber se mudou de facto). */
const reformat = (rule: string | null): string | null =>
  rule === null ? null : ruleFromForm(formFromRule(rule));
