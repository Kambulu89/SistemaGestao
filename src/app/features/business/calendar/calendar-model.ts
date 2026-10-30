import { detailedErrorMessage } from '../../../core/api/error-message';
import type { OccurrenceDto } from './calendar.api';

/** Vistas da agenda e funções puras de datas, fusos e regras de repetição. */
export type ViewMode = 'day' | 'week' | 'month';

export const VIEW_LABEL: Readonly<Record<ViewMode, string>> = {
  day: 'Dia',
  week: 'Semana',
  month: 'Mês',
};

export const WEEKDAYS = [
  { key: 'mon', short: 'Seg', code: 'MO', label: 'Segunda' },
  { key: 'tue', short: 'Ter', code: 'TU', label: 'Terça' },
  { key: 'wed', short: 'Qua', code: 'WE', label: 'Quarta' },
  { key: 'thu', short: 'Qui', code: 'TH', label: 'Quinta' },
  { key: 'fri', short: 'Sex', code: 'FR', label: 'Sexta' },
  { key: 'sat', short: 'Sáb', code: 'SA', label: 'Sábado' },
  { key: 'sun', short: 'Dom', code: 'SU', label: 'Domingo' },
] as const;

const ERRORS: Readonly<Record<string, string>> = {
  RESOURCE_UNAVAILABLE: 'O recurso já está reservado nesse horário.',
  RESOURCE_INACTIVE: 'O recurso está desactivado.',
  RESOURCE_CODE_TAKEN: 'Já existe um recurso com este código.',
  RESOURCE_IN_USE: 'O recurso tem reservas: desactive-o em vez de o apagar.',
  CAPACITY_EXCEEDED: 'A capacidade do recurso não chega para os participantes.',
  HOLD_EXPIRED: 'A reserva provisória venceu.',
  BOOKING_CANCELLED: 'A reserva está cancelada.',
  EVENT_CANCELLED: 'O evento está cancelado.',
  OCCURRENCE_CANCELLED: 'Esta ocorrência foi cancelada.',
  SERIES_HAS_BOOKINGS: 'A série tem reservas: cancele-as antes de mudar o horário ou a repetição.',
  SERIES_HAS_EXCEPTIONS:
    'A série tem excepções que deixariam de corresponder: edite «esta e as seguintes».',
  CALENDAR_NOT_EMPTY: 'O calendário tem eventos.',
  PARTICIPANT_EXISTS: 'Já é participante deste evento.',
  TOO_MANY_OCCURRENCES: 'Há ocorrências a mais para reservar de uma vez: reduza o período.',
  NO_OCCURRENCES: 'Não há ocorrências para reservar neste período.',
  INVALID_TIMEZONE: 'Fuso horário inválido (use um nome IANA, por exemplo Europe/Lisbon).',
  INVALID_RANGE: 'O fim tem de ser depois do início.',
  INVALID_RULE: 'Regra de repetição inválida.',
  STALE_VERSION: 'Os dados mudaram entretanto. Recarregue e tente de novo.',
  BUSINESS_CALENDAR_NAME_TAKEN: 'Já existe um horário com este nome.',
};

export function calendarError(raw: unknown, fallback: string): string {
  // `rxResource` embrulha o erro que não é `Error` e guarda o original em `cause`.
  const error = raw instanceof Error && raw.cause ? raw.cause : raw;
  const code = (error as { code?: string } | null)?.code;
  if (code && ERRORS[code]) return ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) return fields.map((f) => ERRORS[f.code] ?? f.message).join(' ');
  return detailedErrorMessage(error, fallback);
}

// --- datas -------------------------------------------------------------------------------------------

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d: Date): Date => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

/** O intervalo `[from, to)` que a vista mostra em torno de `anchor` (a semana começa à segunda). */
export function rangeOf(mode: ViewMode, anchor: Date): { from: Date; to: Date } {
  if (mode === 'day') return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
  if (mode === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7) };
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const from = startOfWeek(first);
  return { from, to: addDays(from, 42) };
}

export function shift(mode: ViewMode, anchor: Date, direction: -1 | 1): Date {
  if (mode === 'day') return addDays(anchor, direction);
  if (mode === 'week') return addDays(anchor, 7 * direction);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function daysIn(range: { from: Date; to: Date }): Date[] {
  const out: Date[] = [];
  for (let d = range.from; d < range.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** As ocorrências por dia (no fuso do browser); uma que atravessa dias aparece em todos eles. */
export function groupByDay(items: readonly OccurrenceDto[]): Map<string, OccurrenceDto[]> {
  const out = new Map<string, OccurrenceDto[]>();
  for (const item of items) {
    const start = new Date(item.startsAt);
    const end = new Date(item.endsAt);
    // Um evento que acaba à meia-noite exacta não conta como estando no dia seguinte.
    const last = new Date(end.getTime() - 1);
    for (let d = startOfDay(start); d <= last; d = addDays(d, 1)) {
      const key = dayKey(d);
      out.set(key, [...(out.get(key) ?? []), item]);
    }
  }
  return out;
}

export const formatTime = (iso: string, timeZone?: string): string =>
  new Intl.DateTimeFormat('pt-PT', {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));

export const formatDateTime = (iso: string, timeZone?: string): string =>
  new Intl.DateTimeFormat('pt-PT', {
    dateStyle: 'short',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));

export const formatDay = (d: Date): string =>
  new Intl.DateTimeFormat('pt-PT', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(
    d,
  );

export const formatMonth = (d: Date): string =>
  new Intl.DateTimeFormat('pt-PT', { month: 'long', year: 'numeric' }).format(d);

export function titleOf(mode: ViewMode, anchor: Date): string {
  if (mode === 'month') return formatMonth(anchor);
  if (mode === 'day') return formatDay(anchor);
  const { from, to } = rangeOf('week', anchor);
  return `${formatDay(from)} – ${formatDay(addDays(to, -1))}`;
}

// --- fusos -------------------------------------------------------------------------------------------

export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const PARTS = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    PARTS(timeZone)
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return (asUtc - Math.floor(utcMs / 1000) * 1000) / 60000;
}

export function isValidZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone.trim() !== '';
  } catch {
    return false;
  }
}

/** Instante UTC (ISO) → `AAAA-MM-DDTHH:mm` da hora local nesse fuso (para `datetime-local`). */
export function toZonedInput(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    PARTS(timeZone)
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`;
}

/** `AAAA-MM-DDTHH:mm` na hora local de um fuso → instante UTC (ISO). Uma hora que não existe avança. */
export function fromZonedInput(local: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m || !isValidZone(timeZone)) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let utc = guess - offsetMinutes(guess, timeZone) * 60000;
  utc = guess - offsetMinutes(utc, timeZone) * 60000;
  return new Date(utc).toISOString();
}

// --- repetição ---------------------------------------------------------------------------------------

export type Repeat = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export const REPEAT_LABEL: Readonly<Record<Repeat, string>> = {
  NONE: 'Não se repete',
  DAILY: 'Todos os dias',
  WEEKLY: 'Todas as semanas',
  MONTHLY: 'Todos os meses',
  YEARLY: 'Todos os anos',
};

export interface RepeatForm {
  readonly repeat: Repeat;
  readonly interval: number;
  readonly days: readonly string[];
  readonly count: string;
}

/** O formulário → a regra enviada ao servidor (que volta a validá-la). `null` quando não se repete. */
export function ruleFromForm(form: RepeatForm): string | null {
  if (form.repeat === 'NONE') return null;
  const parts = [`FREQ=${form.repeat}`];
  if (form.interval > 1) parts.push(`INTERVAL=${form.interval}`);
  if (form.repeat === 'WEEKLY' && form.days.length > 0) parts.push(`BYDAY=${form.days.join(',')}`);
  const count = String(form.count).trim();
  if (/^\d+$/.test(count) && Number(count) > 0) parts.push(`COUNT=${Number(count)}`);
  return parts.join(';');
}

/** A regra → o formulário (as que o servidor guarda vêm sempre neste formato). */
export function formFromRule(rule: string | null): RepeatForm {
  if (!rule) return { repeat: 'NONE', interval: 1, days: [], count: '' };
  const map = new Map(rule.split(';').map((p) => p.split('=') as [string, string]));
  const freq = map.get('FREQ') as Repeat | undefined;
  return {
    repeat: freq && freq in REPEAT_LABEL ? freq : 'NONE',
    interval: Number(map.get('INTERVAL') ?? 1) || 1,
    days: (map.get('BYDAY') ?? '').split(',').filter(Boolean),
    count: map.get('COUNT') ?? '',
  };
}

export function describeRule(rule: string | null): string {
  if (!rule) return REPEAT_LABEL.NONE;
  const form = formFromRule(rule);
  const unit = { DAILY: 'dia', WEEKLY: 'semana', MONTHLY: 'mês', YEARLY: 'ano', NONE: '' }[
    form.repeat
  ];
  const every = form.interval > 1 ? `A cada ${form.interval} ${unit}s` : REPEAT_LABEL[form.repeat];
  const days =
    form.days.length > 0
      ? ` (${form.days.map((c) => WEEKDAYS.find((w) => w.code === c)?.short ?? c).join(', ')})`
      : '';
  const until = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rule);
  const end = form.count
    ? `, ${form.count} vezes`
    : until
      ? `, até ${until[3]}/${until[2]}/${until[1]}`
      : '';
  return `${every}${days}${end}`;
}

// --- horário útil ------------------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** «09:00-12:00, 13:00-17:00» → períodos; devolve o motivo quando não serve. */
export function parsePeriods(text: string): { periods: [string, string][] } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { periods: [] };
  const periods: [string, string][] = [];
  for (const piece of trimmed.split(',')) {
    const [a, b] = piece.split('-').map((s) => s.trim());
    if (!a || !b || !HHMM.test(a) || !HHMM.test(b) || a >= b)
      return { error: 'Use períodos como 09:00-12:00, 13:00-17:00 (início antes do fim).' };
    periods.push([a, b]);
  }
  periods.sort((x, y) => x[0].localeCompare(y[0]));
  for (let i = 1; i < periods.length; i++) {
    if ((periods[i] as [string, string])[0] < (periods[i - 1] as [string, string])[1])
      return { error: 'Os períodos de um dia não se sobrepõem.' };
  }
  return { periods };
}

export const formatPeriods = (
  periods: readonly (readonly [string, string])[] | undefined,
): string => (periods ?? []).map(([a, b]) => `${a}-${b}`).join(', ');

export const formatMinutes = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
};
