import { Component, computed, input, output } from '@angular/core';
import { Icon } from '../icon';

export interface CalendarEvent {
  date: string;
  label: string;
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
}

export interface CalendarDay {
  date: string;
  day: number;
  inMonth: boolean;
  weekend: boolean;
  today: boolean;
  events: CalendarEvent[];
}

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const MONTHS = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];
export const WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

/**
 * Grelha de um mês (semanas de segunda a domingo, com dias do mês anterior/seguinte para completar), dias de descanso
 * (ISO: 1 = segunda … 7 = domingo) e acontecimentos por data. Em UTC, para não depender do fuso do browser.
 */
export function monthGrid(
  year: number,
  month: number,
  weekendDays: readonly number[],
  events: readonly CalendarEvent[],
  today = new Date().toISOString().slice(0, 10),
): CalendarDay[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = Date.UTC(year, month - 1, 1 - offset);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = Math.ceil((offset + daysInMonth) / 7) * 7;
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  return Array.from({ length: cells }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    const date = isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    const iso = ((d.getUTCDay() + 6) % 7) + 1;
    return {
      date,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month - 1,
      weekend: weekendDays.includes(iso),
      today: date === today,
      events: byDate.get(date) ?? [],
    };
  });
}

/** Mês seguinte/anterior. */
export function shiftMonth(year: number, month: number, delta: number) {
  const m = year * 12 + (month - 1) + delta;
  return { year: Math.floor(m / 12), month: (m % 12) + 1 };
}

/**
 * CalendarPage / vista mensal: navegação por mês, dias de descanso, hoje e acontecimentos (com texto, nunca só cor).
 * Grelha com `role=grid` e cabeçalhos de dia da semana; o resumo do mês (ex.: dias úteis) é projectado.
 */
@Component({
  selector: 'app-calendar-month',
  imports: [Icon],
  template: `
    <section class="card" [attr.aria-label]="label()">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold" aria-live="polite" data-testid="cal-title">
          {{ monthName() }} {{ year() }}
        </h3>
        <div class="flex items-center gap-1">
          <button type="button" class="btn-ghost px-2" aria-label="Mês anterior" (click)="go(-1)">
            <app-icon name="chevronLeft" />
          </button>
          <button type="button" class="btn-secondary" (click)="goToday.emit()">Hoje</button>
          <button type="button" class="btn-ghost px-2" aria-label="Mês seguinte" (click)="go(1)">
            <app-icon name="chevronRight" />
          </button>
        </div>
      </div>
      <ng-content />
      <div role="grid" [attr.aria-label]="monthName() + ' ' + year()" class="text-sm">
        <div role="row" class="grid grid-cols-7 gap-px">
          @for (w of weekdays; track w) {
            <div role="columnheader" class="px-1 py-1 text-center text-xs font-semibold text-muted">
              {{ w }}
            </div>
          }
        </div>
        @for (week of weeks(); track $index) {
          <div role="row" class="grid grid-cols-7 gap-px">
            @for (d of week; track d.date) {
              <div
                role="gridcell"
                class="min-h-16 rounded border border-border p-1"
                [class.bg-surface-2]="d.weekend || !d.inMonth"
                [class.text-subtle]="!d.inMonth"
                [class.border-primary]="d.today"
                [attr.aria-current]="d.today ? 'date' : null"
                [attr.data-date]="d.date"
                [attr.aria-label]="cellLabel(d)"
              >
                <span class="text-xs" [class.font-semibold]="d.today">{{ d.day }}</span>
                @for (e of d.events; track e.label) {
                  <span
                    class="badge mt-0.5 block truncate text-xs"
                    [class]="tone(e.tone)"
                    [attr.title]="e.label"
                    >{{ e.label }}</span
                  >
                }
              </div>
            }
          </div>
        }
      </div>
    </section>
  `,
})
export class CalendarMonth {
  readonly year = input.required<number>();
  readonly month = input.required<number>();
  readonly weekendDays = input<readonly number[]>([6, 7]);
  readonly events = input<readonly CalendarEvent[]>([]);
  readonly label = input('Calendário');
  readonly monthChange = output<{ year: number; month: number }>();
  readonly goToday = output();
  protected readonly weekdays = WEEKDAYS;
  protected readonly monthName = computed(() => MONTHS[this.month() - 1]);
  protected readonly weeks = computed(() => {
    const days = monthGrid(this.year(), this.month(), this.weekendDays(), this.events());
    return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
  });

  protected go(delta: number) {
    this.monthChange.emit(shiftMonth(this.year(), this.month(), delta));
  }

  protected cellLabel(d: CalendarDay) {
    const parts = [`${d.day} de ${MONTHS[Number(d.date.slice(5, 7)) - 1]}`];
    if (d.weekend) parts.push('descanso');
    for (const e of d.events) parts.push(e.label);
    return parts.join(', ');
  }

  protected tone(t: CalendarEvent['tone']) {
    return {
      neutral: 'bg-info-soft text-info-text',
      warning: 'bg-warning-soft text-warning-text',
      danger: 'bg-danger-soft text-danger-text',
      success: 'bg-success-soft text-success-text',
    }[t ?? 'neutral'];
  }
}
