import { DateTime } from 'luxon'

/**
 * Calendário, recursos e reservas (S03). Tudo aqui é puro: fusos IANA, regras de repetição, expansão de ocorrências
 * num intervalo limitado e horário útil. Os intervalos são sempre `[início, fim)`, por isso reservas adjacentes não
 * colidem.
 */

export const CALENDAR_VISIBILITIES = ['PRIVATE', 'UNIT', 'TENANT'] as const
export type CalendarVisibility = (typeof CALENDAR_VISIBILITIES)[number]

export const RESOURCE_TYPES = ['ROOM', 'EQUIPMENT', 'VEHICLE', 'OTHER'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export const EVENT_STATUSES = ['TENTATIVE', 'CONFIRMED', 'CANCELLED'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export const BOOKING_STATUSES = ['HELD', 'CONFIRMED', 'CANCELLED'] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export const RESPONSES = ['PENDING', 'ACCEPTED', 'DECLINED'] as const
export type ParticipantResponse = (typeof RESPONSES)[number]

/** Intervalo máximo de uma consulta e limites das reservas de séries. */
export const MAX_RANGE_DAYS = 366
export const DEFAULT_BOOKING_HORIZON_DAYS = 90
export const MAX_BOOKING_HORIZON_DAYS = 366
export const MAX_BOOKED_OCCURRENCES = 120
export const MAX_HOLD_MINUTES = 24 * 60
export const MAX_EVENT_HOURS = 24 * 31
const MAX_ITERATIONS = 5000

export interface Issue {
  path: string
  code: string
  message: string
}

export const isValidZone = (zone: unknown): zone is string =>
  typeof zone === 'string' &&
  zone.length > 0 &&
  zone.length <= 64 &&
  DateTime.local().setZone(zone).isValid

// --- regras de repetição ---------------------------------------------------------------------------

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RecurrenceRule {
  freq: Frequency
  interval: number
  count: number | null
  until: Date | null
  /** 1 = segunda … 7 = domingo; só para `WEEKLY`. */
  byDay: number[]
}

const DAYS: Readonly<Record<string, number>> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 }
const DAY_CODES = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
export const MAX_RULE_COUNT = 1000

function parseUntil(text: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(text)
  if (!m) return null
  const date = DateTime.utc(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] ? Number(m[4]) : 23,
    m[5] ? Number(m[5]) : 59,
    m[6] ? Number(m[6]) : 59
  )
  return date.isValid ? date.toJSDate() : null
}

/**
 * Subconjunto de RRULE: `FREQ` (DAILY, WEEKLY, MONTHLY, YEARLY), `INTERVAL`, `COUNT` ou `UNTIL` (nunca os dois) e,
 * para `WEEKLY`, `BYDAY`. Tudo o resto é recusado em vez de ignorado em silêncio.
 */
export function parseRule(text: string): { rule: RecurrenceRule } | { error: string } {
  if (text.length > 500) return { error: 'A regra de repetição tem demasiados caracteres.' }
  const parts = new Map<string, string>()
  for (const piece of text.split(';')) {
    const [key = '', value = ''] = piece.split('=')
    const upper = key.trim().toUpperCase()
    if (!upper || !value || parts.has(upper)) return { error: 'Regra de repetição inválida.' }
    parts.set(upper, value.trim())
  }
  for (const key of parts.keys()) {
    if (!['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY'].includes(key))
      return { error: `A regra de repetição não suporta «${key}».` }
  }
  const freq = parts.get('FREQ')?.toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY')
    return { error: 'FREQ tem de ser DAILY, WEEKLY, MONTHLY ou YEARLY.' }
  const intervalText = parts.get('INTERVAL') ?? '1'
  const interval = Number(intervalText)
  if (!/^\d+$/.test(intervalText) || interval < 1 || interval > 365)
    return { error: 'INTERVAL tem de estar entre 1 e 365.' }
  if (parts.has('COUNT') && parts.has('UNTIL')) return { error: 'Use COUNT ou UNTIL, não os dois.' }
  let count: number | null = null
  if (parts.has('COUNT')) {
    const text2 = parts.get('COUNT') as string
    count = Number(text2)
    if (!/^\d+$/.test(text2) || count < 1 || count > MAX_RULE_COUNT)
      return { error: `COUNT tem de estar entre 1 e ${MAX_RULE_COUNT}.` }
  }
  let until: Date | null = null
  if (parts.has('UNTIL')) {
    until = parseUntil(parts.get('UNTIL') as string)
    if (!until) return { error: 'UNTIL tem de ser AAAAMMDD ou AAAAMMDDTHHMMSSZ.' }
  }
  const byDay: number[] = []
  if (parts.has('BYDAY')) {
    if (freq !== 'WEEKLY') return { error: 'BYDAY só se usa com FREQ=WEEKLY.' }
    for (const code of (parts.get('BYDAY') as string).toUpperCase().split(',')) {
      const day = DAYS[code]
      if (!day) return { error: `Dia da semana inválido em BYDAY: «${code}».` }
      if (!byDay.includes(day)) byDay.push(day)
    }
    byDay.sort((a, b) => a - b)
  }
  return { rule: { freq, interval, count, until, byDay } }
}

export function formatRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.map((d) => DAY_CODES[d]).join(',')}`)
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`)
  if (rule.until) {
    parts.push(
      `UNTIL=${DateTime.fromJSDate(rule.until, { zone: 'utc' }).toFormat("yyyyMMdd'T'HHmmss'Z'")}`
    )
  }
  return parts.join(';')
}

// --- expansão de ocorrências -----------------------------------------------------------------------

export interface Series {
  startsAt: Date
  endsAt: Date
  timezone: string
  allDay: boolean
  rule: RecurrenceRule | null
}

export interface Occurrence {
  /** O início original da ocorrência: identifica-a para sempre (excepções e reservas usam-no). */
  occurrenceStart: Date
  startsAt: Date
  endsAt: Date
}

/**
 * As ocorrências que **começam** em `[from, to)`, na ordem. A hora local mantém-se quando o fuso muda de hora (uma
 * reunião às 10:00 continua às 10:00) e a duração decorrida é a do evento (uma hora continua a ser uma hora); numa
 * hora que não existe (a que o relógio salta) o instante avança para a seguinte. Num dia inteiro conta-se em dias.
 */
export function expand(series: Series, from: Date, to: Date, limit = 1000): Occurrence[] {
  const zone = series.timezone
  const base = DateTime.fromJSDate(series.startsAt, { zone })
  const durationMs = series.endsAt.getTime() - series.startsAt.getTime()
  const spanDays = series.allDay
    ? Math.max(
        1,
        Math.round(
          DateTime.fromJSDate(series.endsAt, { zone })
            .startOf('day')
            .diff(base.startOf('day'), 'days').days
        )
      )
    : 0

  const make = (start: DateTime): Occurrence => {
    const startsAt = series.allDay ? start.startOf('day') : start
    const endsAt = series.allDay
      ? startsAt.plus({ days: spanDays })
      : DateTime.fromMillis(startsAt.toMillis() + durationMs, { zone })
    return {
      occurrenceStart: startsAt.toJSDate(),
      startsAt: startsAt.toJSDate(),
      endsAt: endsAt.toJSDate(),
    }
  }

  const rule = series.rule
  if (!rule) {
    const only = make(base)
    return only.occurrenceStart >= from && only.occurrenceStart < to ? [only] : []
  }

  const out: Occurrence[] = []
  let produced = 0
  let guard = 0
  const stop = (start: DateTime): boolean => {
    if (rule.until && start.toMillis() > rule.until.getTime()) return true
    return start.toMillis() >= to.getTime()
  }
  const push = (start: DateTime): boolean => {
    // `false` quando já não há mais nada a gerar.
    if (rule.count !== null && produced >= rule.count) return false
    if (stop(start)) return false
    produced += 1
    const occurrence = make(start)
    if (occurrence.occurrenceStart >= from) out.push(occurrence)
    return out.length < limit
  }

  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length > 0 ? rule.byDay : [base.weekday]
    const weekStart = base.startOf('day').minus({ days: base.weekday - 1 })
    for (let n = 0; guard < MAX_ITERATIONS; n += 1) {
      const monday = weekStart.plus({ weeks: n * rule.interval })
      let more = true
      for (const day of days) {
        guard += 1
        const candidate = monday
          .plus({ days: day - 1 })
          .set({ hour: base.hour, minute: base.minute, second: base.second, millisecond: 0 })
        if (candidate.toMillis() < base.toMillis()) continue
        more = push(candidate)
        if (!more) break
      }
      if (!more) break
      if (stop(monday)) break
    }
    return out
  }

  for (let n = 0; guard < MAX_ITERATIONS; n += 1) {
    guard += 1
    const step = n * rule.interval
    const candidate =
      rule.freq === 'DAILY'
        ? base.plus({ days: step })
        : rule.freq === 'MONTHLY'
          ? base.plus({ months: step })
          : base.plus({ years: step })
    // Como na norma, um dia que não existe nesse mês/ano (31 de Abril, 29 de Fevereiro) salta.
    if (rule.freq !== 'DAILY' && candidate.day !== base.day) {
      if (stop(candidate)) break
      continue
    }
    if (!push(candidate)) break
  }
  return out
}

/** Dois intervalos `[início, fim)` sobrepõem-se? */
export const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean =>
  aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime()

// --- validação ---------------------------------------------------------------------------------------

export interface EventTimes {
  startsAt: Date
  endsAt: Date
  timezone: string
  allDay: boolean
  recurrence: RecurrenceRule | null
}

export function validateTimes(input: {
  startsAt: unknown
  endsAt: unknown
  timezone: unknown
  allDay: unknown
  recurrenceRule: unknown
}): { value: EventTimes } | { issues: Issue[] } {
  const issues: Issue[] = []
  const startsAt = toDate(input.startsAt)
  const endsAt = toDate(input.endsAt)
  if (!startsAt) issues.push({ path: 'startsAt', code: 'INVALID', message: 'Início inválido.' })
  if (!endsAt) issues.push({ path: 'endsAt', code: 'INVALID', message: 'Fim inválido.' })
  if (!isValidZone(input.timezone))
    issues.push({
      path: 'timezone',
      code: 'INVALID_TIMEZONE',
      message: 'Fuso horário IANA inválido.',
    })
  if (startsAt && endsAt) {
    if (endsAt.getTime() <= startsAt.getTime())
      issues.push({
        path: 'endsAt',
        code: 'INVALID_RANGE',
        message: 'O fim tem de ser depois do início.',
      })
    else if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_HOURS * 3_600_000)
      issues.push({
        path: 'endsAt',
        code: 'TOO_LONG',
        message: 'Um evento não dura mais de 31 dias.',
      })
  }
  let recurrence: RecurrenceRule | null = null
  if (typeof input.recurrenceRule === 'string' && input.recurrenceRule.trim() !== '') {
    const parsed = parseRule(input.recurrenceRule.trim())
    if ('error' in parsed)
      issues.push({ path: 'recurrenceRule', code: 'INVALID_RULE', message: parsed.error })
    else recurrence = parsed.rule
  } else if (
    input.recurrenceRule !== null &&
    input.recurrenceRule !== undefined &&
    input.recurrenceRule !== ''
  ) {
    issues.push({
      path: 'recurrenceRule',
      code: 'INVALID_RULE',
      message: 'Regra de repetição inválida.',
    })
  }
  if (issues.length > 0 || !startsAt || !endsAt) return { issues }
  return {
    value: {
      startsAt,
      endsAt,
      timezone: input.timezone as string,
      allDay: input.allDay === true,
      recurrence,
    },
  }
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** O intervalo de uma consulta: obrigatório e limitado. */
export function validateRange(
  from: unknown,
  to: unknown
): { from: Date; to: Date } | { issue: Issue } {
  const start = toDate(from)
  const end = toDate(to)
  if (!start || !end)
    return { issue: { path: 'from', code: 'INVALID', message: 'Indique from e to (ISO 8601).' } }
  if (end.getTime() <= start.getTime())
    return {
      issue: { path: 'to', code: 'INVALID_RANGE', message: 'to tem de ser depois de from.' },
    }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86_400_000)
    return {
      issue: {
        path: 'to',
        code: 'RANGE_TOO_LARGE',
        message: `O intervalo não passa de ${MAX_RANGE_DAYS} dias.`,
      },
    }
  return { from: start, to: end }
}

// --- horário útil -------------------------------------------------------------------------------------

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number]
export type WorkingHours = Partial<Record<WeekdayKey, [string, string][]>>
export interface Holiday {
  date: string
  name: string
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const minutesOf = (text: string): number => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))

export function validateWorkingHours(
  value: unknown
): { value: WorkingHours } | { issues: Issue[] } {
  const issues: Issue[] = []
  const out: WorkingHours = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {
      issues: [
        { path: 'weeklyWorkingHours', code: 'INVALID', message: 'Horário semanal inválido.' },
      ],
    }
  for (const [key, ranges] of Object.entries(value as Record<string, unknown>)) {
    if (!(WEEKDAY_KEYS as readonly string[]).includes(key)) {
      issues.push({
        path: `weeklyWorkingHours.${key}`,
        code: 'INVALID',
        message: 'Dia da semana desconhecido.',
      })
      continue
    }
    if (!Array.isArray(ranges) || ranges.length > 6) {
      issues.push({
        path: `weeklyWorkingHours.${key}`,
        code: 'INVALID',
        message: 'Até 6 períodos por dia.',
      })
      continue
    }
    const parsed: [string, string][] = []
    for (const range of ranges) {
      const [a, b] = Array.isArray(range) ? range : []
      if (
        typeof a !== 'string' ||
        typeof b !== 'string' ||
        !HHMM.test(a) ||
        !HHMM.test(b) ||
        minutesOf(a) >= minutesOf(b)
      ) {
        issues.push({
          path: `weeklyWorkingHours.${key}`,
          code: 'INVALID_RANGE',
          message: 'Cada período é [«HH:MM», «HH:MM»] com início antes do fim.',
        })
        continue
      }
      parsed.push([a, b])
    }
    parsed.sort((x, y) => minutesOf(x[0]) - minutesOf(y[0]))
    for (let i = 1; i < parsed.length; i += 1) {
      if (
        minutesOf((parsed[i] as [string, string])[0]) <
        minutesOf((parsed[i - 1] as [string, string])[1])
      )
        issues.push({
          path: `weeklyWorkingHours.${key}`,
          code: 'OVERLAP',
          message: 'Os períodos não se sobrepõem.',
        })
    }
    out[key as WeekdayKey] = parsed
  }
  return issues.length > 0 ? { issues } : { value: out }
}

export function validateHolidays(value: unknown): { value: Holiday[] } | { issues: Issue[] } {
  if (!Array.isArray(value) || value.length > 400)
    return {
      issues: [{ path: 'holidays', code: 'INVALID', message: 'Feriados inválidos (até 400).' }],
    }
  const seen = new Set<string>()
  const out: Holiday[] = []
  for (const [i, item] of value.entries()) {
    const date = (item as { date?: unknown } | null)?.date
    const name = (item as { name?: unknown } | null)?.name
    if (
      typeof date !== 'string' ||
      !DateTime.fromISO(date, { zone: 'utc' }).isValid ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      name.length > 120
    )
      return {
        issues: [
          { path: `holidays.${i}`, code: 'INVALID', message: 'Feriado: {date: AAAA-MM-DD, name}.' },
        ],
      }
    if (seen.has(date))
      return {
        issues: [{ path: `holidays.${i}`, code: 'DUPLICATE', message: 'Feriado repetido.' }],
      }
    seen.add(date)
    out.push({ date, name: name.trim() })
  }
  return { value: out.sort((a, b) => a.date.localeCompare(b.date)) }
}

/**
 * Minutos úteis decorridos entre dois instantes, no fuso do calendário: soma os períodos de cada dia da semana,
 * exclui feriados e conta tempo real (num dia em que o relógio muda, o período de trabalho continua a medir-se em
 * tempo decorrido).
 */
export function workingMinutes(
  calendar: { timezone: string; hours: WorkingHours; holidays: readonly Holiday[] },
  from: Date,
  to: Date
): number {
  if (to.getTime() <= from.getTime()) return 0
  const holidays = new Set(calendar.holidays.map((h) => h.date))
  const zone = calendar.timezone
  const last = DateTime.fromJSDate(to, { zone }).startOf('day')
  let day = DateTime.fromJSDate(from, { zone }).startOf('day')
  let total = 0
  for (let guard = 0; day <= last && guard < MAX_RANGE_DAYS * 5; guard += 1) {
    const key = WEEKDAY_KEYS[day.weekday - 1] as WeekdayKey
    if (!holidays.has(day.toISODate() as string)) {
      for (const [a, b] of calendar.hours[key] ?? []) {
        const start = day.set({ hour: Number(a.slice(0, 2)), minute: Number(a.slice(3, 5)) })
        const end = day.set({ hour: Number(b.slice(0, 2)), minute: Number(b.slice(3, 5)) })
        const lo = Math.max(start.toMillis(), from.getTime())
        const hi = Math.min(end.toMillis(), to.getTime())
        if (hi > lo) total += (hi - lo) / 60_000
      }
    }
    day = day.plus({ days: 1 })
  }
  return total
}
