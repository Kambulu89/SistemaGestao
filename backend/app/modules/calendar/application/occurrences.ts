import {
  expand,
  overlaps,
  parseRule,
  type RecurrenceRule,
  type Series,
} from '#modules/calendar/domain/calendar'
import type { EventRecord, ExceptionRecord } from '#modules/calendar/application/ports'

export interface ResolvedOccurrence {
  eventId: string
  /** `null` num evento que não se repete. */
  occurrenceStart: Date | null
  startsAt: Date
  endsAt: Date
  title: string
  modified: boolean
  recurring: boolean
}

export const ruleOf = (event: Pick<EventRecord, 'recurrenceRule'>): RecurrenceRule | null => {
  if (!event.recurrenceRule) return null
  const parsed = parseRule(event.recurrenceRule)
  return 'rule' in parsed ? parsed.rule : null
}

export const seriesOf = (event: EventRecord): Series => ({
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  timezone: event.timezone,
  allDay: event.allDay,
  rule: ruleOf(event),
})

/**
 * As ocorrências que tocam em `[from, to)` com as excepções aplicadas: uma cancelada nunca aparece (a excepção
 * persiste mesmo que a regra mude) e uma alterada aparece onde foi posta, venha de onde vier.
 */
export function resolveOccurrences(
  event: EventRecord,
  exceptions: readonly ExceptionRecord[],
  from: Date,
  to: Date,
  limit = 1000
): ResolvedOccurrence[] {
  const series = seriesOf(event)
  if (!series.rule) {
    return overlaps(event.startsAt, event.endsAt, from, to)
      ? [
          {
            eventId: event.id,
            occurrenceStart: null,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            title: event.title,
            modified: false,
            recurring: false,
          },
        ]
      : []
  }
  const byKey = new Map(exceptions.map((x) => [x.occurrenceStart.getTime(), x]))
  const duration = event.endsAt.getTime() - event.startsAt.getTime()
  const widened = new Date(from.getTime() - duration - 86_400_000)
  const out: ResolvedOccurrence[] = []
  const seen = new Set<number>()
  for (const o of expand(series, widened, to, limit)) {
    const key = o.occurrenceStart.getTime()
    seen.add(key)
    const exception = byKey.get(key)
    if (exception?.kind === 'CANCELLED') continue
    const startsAt = exception?.startsAt ?? o.startsAt
    const endsAt = exception?.endsAt ?? o.endsAt
    if (!overlaps(startsAt, endsAt, from, to)) continue
    out.push({
      eventId: event.id,
      occurrenceStart: o.occurrenceStart,
      startsAt,
      endsAt,
      title: exception?.title ?? event.title,
      modified: exception?.kind === 'MODIFIED',
      recurring: true,
    })
  }
  for (const exception of exceptions) {
    if (exception.kind !== 'MODIFIED' || !exception.startsAt || !exception.endsAt) continue
    if (seen.has(exception.occurrenceStart.getTime())) continue
    if (!overlaps(exception.startsAt, exception.endsAt, from, to)) continue
    out.push({
      eventId: event.id,
      occurrenceStart: exception.occurrenceStart,
      startsAt: exception.startsAt,
      endsAt: exception.endsAt,
      title: exception.title ?? event.title,
      modified: true,
      recurring: true,
    })
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, limit)
}

/** `occurrenceStart` é mesmo uma ocorrência da série (e não uma hora qualquer)? */
export function isGenuineOccurrence(event: EventRecord, occurrenceStart: Date): boolean {
  const series = seriesOf(event)
  if (!series.rule) return false
  const found = expand(series, occurrenceStart, new Date(occurrenceStart.getTime() + 1), 1)
  return found.length === 1 && found[0]?.occurrenceStart.getTime() === occurrenceStart.getTime()
}

/** Quantas ocorrências da série começam antes de `before` (serve para repartir o COUNT numa divisão). */
export function occurrencesBefore(event: EventRecord, before: Date): number {
  const series = seriesOf(event)
  return expand(series, event.startsAt, before, 5000).length
}
