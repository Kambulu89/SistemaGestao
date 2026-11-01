import { DateTime } from 'luxon'

/**
 * Calendário de cinco campos (minuto hora dia-do-mês mês dia-da-semana) avaliado num fuso horário. Aceita `*`, listas
 * (`1,15`), intervalos (`9-17`) e passos (asterisco e barra e 15, ou `0-30/10`). Dia-da-semana: 0 ou 7 = domingo. Quando o dia-do-mês e o
 * dia-da-semana estão ambos restritos, basta um deles (como o cron clássico).
 */
export interface CronSpec {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  daysOfMonth: ReadonlySet<number>
  months: ReadonlySet<number>
  daysOfWeek: ReadonlySet<number>
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

const RANGES = [
  { name: 'minuto', min: 0, max: 59 },
  { name: 'hora', min: 0, max: 23 },
  { name: 'dia do mês', min: 1, max: 31 },
  { name: 'mês', min: 1, max: 12 },
  { name: 'dia da semana', min: 0, max: 7 },
] as const

function parseField(text: string, index: number): ReadonlySet<number> | string {
  const { name, min, max } = RANGES[index] as (typeof RANGES)[number]
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const [rangeText = '', stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (
      !Number.isInteger(step) ||
      step < 1 ||
      (stepText !== undefined && !/^\d+$/.test(stepText))
    ) {
      return `Passo inválido no campo «${name}».`
    }
    let from: number
    let to: number
    if (rangeText === '*') {
      from = min
      to = max
    } else if (/^\d+$/.test(rangeText)) {
      from = Number(rangeText)
      to = stepText === undefined ? from : max
    } else if (/^\d+-\d+$/.test(rangeText)) {
      ;[from, to] = rangeText.split('-').map(Number) as [number, number]
    } else {
      return `Valor inválido no campo «${name}».`
    }
    if (from < min || to > max || from > to) return `Fora do intervalo no campo «${name}».`
    for (let v = from; v <= to; v += step) values.add(index === 4 && v === 7 ? 0 : v)
  }
  return values
}

/** Interpreta a expressão; devolve a razão se for inválida. */
export function parseCron(expression: string): CronSpec | string {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5)
    return 'O calendário tem cinco campos: minuto hora dia mês dia-da-semana.'
  const parsed: ReadonlySet<number>[] = []
  for (const [i, field] of fields.entries()) {
    const result = parseField(field, i)
    if (typeof result === 'string') return result
    parsed.push(result)
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as [
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
  ]
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: fields[2] === '*',
    anyDayOfWeek: fields[4] === '*',
  }
}

export const isValidTimezone = (zone: string): boolean => DateTime.local().setZone(zone).isValid

function dayMatches(spec: CronSpec, day: DateTime): boolean {
  if (!spec.months.has(day.month)) return false
  const domOk = spec.daysOfMonth.has(day.day)
  const dowOk = spec.daysOfWeek.has(day.weekday % 7)
  if (spec.anyDayOfMonth && spec.anyDayOfWeek) return true
  if (spec.anyDayOfMonth) return dowOk
  if (spec.anyDayOfWeek) return domOk
  return domOk || dowOk
}

const SEARCH_DAYS = 366 * 5

/**
 * O primeiro instante **posterior** a `after` em que o calendário dispara, no fuso indicado (`null` se nunca, p. ex.
 * 30 de Fevereiro). Percorre dias e só então horas e minutos, por isso é barato mesmo para calendários anuais.
 */
export function nextFire(spec: CronSpec, zone: string, after: Date): Date | null {
  const start = DateTime.fromJSDate(after, { zone }).plus({ minutes: 1 }).startOf('minute')
  const hours = [...spec.hours].sort((a, b) => a - b)
  const minutes = [...spec.minutes].sort((a, b) => a - b)
  for (let d = 0; d < SEARCH_DAYS; d++) {
    const day = start.plus({ days: d }).startOf('day')
    if (!dayMatches(spec, day)) continue
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = day.set({ hour, minute })
        // Horas que não existem (mudança de hora) saltam-se; as repetidas disparam uma só vez.
        if (candidate.hour !== hour || candidate.minute !== minute) continue
        if (candidate >= start) return candidate.toJSDate()
      }
    }
  }
  return null
}

/** Intervalo mínimo entre disparos que se aceita (evita automações a correr a cada minuto). */
export const MIN_INTERVAL_MS = 5 * 60_000

/** `true` se, numa amostra de disparos, algum intervalo for inferior ao mínimo. */
export function tooFrequent(spec: CronSpec, zone: string): boolean {
  let previous = nextFire(spec, zone, new Date('2026-01-01T00:00:00Z'))
  for (let i = 0; i < 200 && previous; i++) {
    const next = nextFire(spec, zone, previous)
    if (!next) return false
    if (next.getTime() - previous.getTime() < MIN_INTERVAL_MS) return true
    previous = next
  }
  return false
}
