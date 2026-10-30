import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  DEFAULT_BOOKING_HORIZON_DAYS,
  EVENT_STATUSES,
  MAX_BOOKED_OCCURRENCES,
  MAX_BOOKING_HORIZON_DAYS,
  MAX_EVENT_HOURS,
  MAX_HOLD_MINUTES,
  RESPONSES,
  expand,
  formatRule,
  parseRule,
  toDate,
  validateRange,
  validateTimes,
  type EventStatus,
  type ParticipantResponse,
} from '#modules/calendar/domain/calendar'
import { calendarValidation, failure, unavailable } from '#modules/calendar/application/errors'
import {
  isGenuineOccurrence,
  occurrencesBefore,
  resolveOccurrences,
  ruleOf,
} from '#modules/calendar/application/occurrences'
import {
  BookingCollision,
  type BookingRecord,
  type BookingStore,
  type Clock,
  type EventRecord,
  type EventStore,
  type ParticipantRecord,
  type Viewer,
} from '#modules/calendar/application/ports'
import {
  viewerOf,
  type CalendarUseCases,
  type ResourceUseCases,
} from '#modules/calendar/application/calendar_use_cases'

type Scope = Parameters<Parameters<TenantUnitOfWork['run']>[0]>[0]
export type EditScope = 'ALL' | 'THIS' | 'FUTURE'
const SCOPES: readonly EditScope[] = ['ALL', 'THIS', 'FUTURE']

export interface EventView {
  id: string
  calendarId: string
  title: string
  description: string | null
  startsAt: string
  endsAt: string
  timezone: string
  allDay: boolean
  recurrenceRule: string | null
  status: EventStatus
  sourceType: string | null
  sourceId: string | null
  version: number
  createdAt: string
}

export interface OccurrenceView {
  eventId: string
  calendarId: string
  title: string
  startsAt: string
  endsAt: string
  occurrenceStart: string | null
  allDay: boolean
  timezone: string
  recurring: boolean
  modified: boolean
  status: EventStatus
}

export interface BookingView {
  id: string
  eventId: string
  resourceId: string
  occurrenceStart: string | null
  startsAt: string
  endsAt: string
  status: 'HELD' | 'CONFIRMED' | 'CANCELLED'
  expiresAt: string | null
  cancelReason: string | null
  eventTitle?: string | null
}

export interface ParticipantView {
  id: string
  membershipId: string | null
  partyId: string | null
  response: ParticipantResponse
}

export interface EventDetail extends EventView {
  exceptions: {
    occurrenceStart: string
    kind: 'CANCELLED' | 'MODIFIED'
    title: string | null
    startsAt: string | null
    endsAt: string | null
  }[]
  participants: ParticipantView[]
  bookings: BookingView[]
}

const eventView = (e: EventRecord): EventView => ({
  id: e.id,
  calendarId: e.calendarId,
  title: e.title,
  description: e.description,
  startsAt: e.startsAt.toISOString(),
  endsAt: e.endsAt.toISOString(),
  timezone: e.timezone,
  allDay: e.allDay,
  recurrenceRule: e.recurrenceRule,
  status: e.status,
  sourceType: e.sourceType,
  sourceId: e.sourceId,
  version: e.version,
  createdAt: e.createdAt.toISOString(),
})

const bookingView = (b: BookingRecord, eventTitle?: string | null): BookingView => ({
  id: b.id,
  eventId: b.eventId,
  resourceId: b.resourceId,
  occurrenceStart: b.occurrenceStart ? b.occurrenceStart.toISOString() : null,
  startsAt: b.startsAt.toISOString(),
  endsAt: b.endsAt.toISOString(),
  status: b.status,
  expiresAt: b.expiresAt ? b.expiresAt.toISOString() : null,
  cancelReason: b.cancelReason,
  ...(eventTitle !== undefined ? { eventTitle } : {}),
})

const participantView = (p: ParticipantRecord): ParticipantView => ({
  id: p.id,
  membershipId: p.membershipId,
  partyId: p.partyId,
  response: p.response,
})

const has = (input: Record<string, unknown>, key: string) => key in input

const optionalText = (value: unknown, path: string, max: number): string | null => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > max)
    throw failure(path, 'INVALID', `Texto inválido (até ${max} caracteres).`)
  return value
}

const requiredTitle = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 200)
    throw failure('title', 'INVALID', 'O título é obrigatório (até 200 caracteres).')
  return value.trim()
}

const scopeOf = (input: Record<string, unknown>): EditScope => {
  const scope = input['scope'] ?? 'ALL'
  if (!(SCOPES as readonly unknown[]).includes(scope))
    throw failure('scope', 'INVALID', 'scope: ALL, THIS ou FUTURE.')
  return scope as EditScope
}

const occurrenceOf = (input: Record<string, unknown>): Date => {
  const date = toDate(input['occurrenceStart'])
  if (!date)
    throw failure(
      'occurrenceStart',
      'REQUIRED',
      'Indique o início da ocorrência (occurrenceStart).'
    )
  return date
}

const keyOf = (date: Date | null) => (date ? date.getTime() : 0)

/** Eventos: séries com excepções, participantes e o cancelamento que avisa quem participa. */
export class EventUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly events: EventStore,
    private readonly bookings: BookingStore,
    private readonly calendars: CalendarUseCases,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  private async visibleEvent(scope: Scope, viewer: Viewer, id: string, lock = false) {
    const event = lock ? await this.events.lock(scope, id) : await this.events.find(scope, id)
    if (!event) throw ApiError.notFound()
    await this.calendars.visible(scope, viewer, event.calendarId)
    return event
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<EventView> {
    const viewer = viewerOf(context)
    const title = requiredTitle(input['title'])
    return this.uow.run(async (scope) => {
      if (typeof input['calendarId'] !== 'string')
        throw failure('calendarId', 'REQUIRED', 'Indique o calendário.')
      const calendar = await this.calendars.visible(scope, viewer, input['calendarId'])
      const times = validateTimes({
        startsAt: input['startsAt'],
        endsAt: input['endsAt'],
        timezone: input['timezone'] ?? calendar.timezone,
        allDay: input['allDay'],
        recurrenceRule: input['recurrenceRule'],
      })
      if ('issues' in times) throw calendarValidation(times.issues)
      const status = input['status'] ?? 'CONFIRMED'
      if (!(EVENT_STATUSES as readonly unknown[]).includes(status) || status === 'CANCELLED')
        throw failure('status', 'INVALID', 'Estado: TENTATIVE ou CONFIRMED.')
      const sourceType = optionalText(input['sourceType'], 'sourceType', 50)
      const sourceId = optionalText(input['sourceId'], 'sourceId', 64)
      if ((sourceType === null) !== (sourceId === null))
        throw failure('sourceType', 'INVALID', 'Origem: indique sourceType e sourceId juntos.')
      const created = await this.events.insert(scope, {
        calendarId: calendar.id,
        title,
        description: optionalText(input['description'], 'description', 4000),
        startsAt: times.value.startsAt,
        endsAt: times.value.endsAt,
        timezone: times.value.timezone,
        allDay: times.value.allDay,
        recurrenceRule: times.value.recurrence ? formatRule(times.value.recurrence) : null,
        status: status as EventStatus,
        sourceType,
        sourceId,
      })
      return eventView(created)
    }, context)
  }

  /** As ocorrências que tocam em `[from, to)` nos calendários que a pessoa vê. */
  async list(
    context: TenantContext,
    query: { from: unknown; to: unknown; calendarId?: string | null }
  ): Promise<{ items: OccurrenceView[]; asOf: string }> {
    const viewer = viewerOf(context)
    const range = validateRange(query.from, query.to)
    if ('issue' in range) throw calendarValidation([range.issue])
    return this.uow.run(async (scope) => {
      const candidates = await this.events.candidates(
        scope,
        viewer,
        range.from,
        range.to,
        query.calendarId ?? null
      )
      const exceptions = await this.events.exceptions(
        scope,
        candidates.filter((e) => e.recurrenceRule).map((e) => e.id)
      )
      const items: OccurrenceView[] = []
      for (const event of candidates) {
        const mine = exceptions.filter((x) => x.eventId === event.id)
        for (const o of resolveOccurrences(event, mine, range.from, range.to)) {
          items.push({
            eventId: event.id,
            calendarId: event.calendarId,
            title: o.title,
            startsAt: o.startsAt.toISOString(),
            endsAt: o.endsAt.toISOString(),
            occurrenceStart: o.occurrenceStart ? o.occurrenceStart.toISOString() : null,
            allDay: event.allDay,
            timezone: event.timezone,
            recurring: o.recurring,
            modified: o.modified,
            status: event.status,
          })
        }
      }
      items.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      return { items: items.slice(0, 2000), asOf: this.clock.now().toISOString() }
    }, context)
  }

  async get(context: TenantContext, id: string): Promise<EventDetail> {
    const viewer = viewerOf(context)
    return this.uow.run(async (scope) => {
      const event = await this.visibleEvent(scope, viewer, id)
      const [exceptions, participants, bookings] = await Promise.all([
        this.events.exceptions(scope, [id]),
        this.events.participants(scope, id),
        this.bookings.activeOfEvent(scope, id, this.clock.now()),
      ])
      return {
        ...eventView(event),
        exceptions: exceptions.map((x) => ({
          occurrenceStart: x.occurrenceStart.toISOString(),
          kind: x.kind,
          title: x.title,
          startsAt: x.startsAt ? x.startsAt.toISOString() : null,
          endsAt: x.endsAt ? x.endsAt.toISOString() : null,
        })),
        participants: participants.map(participantView),
        bookings: bookings.map((b) => bookingView(b)),
      }
    }, context)
  }

  // --- edição --------------------------------------------------------------------------------------

  async update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>
  ): Promise<EventView> {
    const viewer = viewerOf(context)
    const scopeKind = scopeOf(input)
    const version = input['version']
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
      throw failure('version', 'REQUIRED', 'Indique a versão lida (version).')
    return this.uow.run(async (scope) => {
      const event = await this.visibleEvent(scope, viewer, id, true)
      if (event.status === 'CANCELLED')
        throw ApiError.conflict('EVENT_CANCELLED', 'O evento está cancelado.')
      if (event.version !== version) throw ApiError.versionConflict(event.version)
      if (scopeKind === 'ALL') return this.updateAll(scope, event, input)
      if (!ruleOf(event))
        throw failure(
          'scope',
          'NOT_RECURRING',
          'Só se edita uma ocorrência de um evento que se repete.'
        )
      const occurrence = occurrenceOf(input)
      if (!isGenuineOccurrence(event, occurrence))
        throw failure(
          'occurrenceStart',
          'INVALID_OCCURRENCE',
          'Esta não é uma ocorrência da série.'
        )
      if (scopeKind === 'THIS') return this.updateThis(scope, event, occurrence, input)
      return this.updateFuture(scope, event, occurrence, input)
    }, context)
  }

  private async updateAll(scope: Scope, event: EventRecord, input: Record<string, unknown>) {
    const merged = {
      startsAt: has(input, 'startsAt') ? input['startsAt'] : event.startsAt,
      endsAt: has(input, 'endsAt') ? input['endsAt'] : event.endsAt,
      timezone: has(input, 'timezone') ? input['timezone'] : event.timezone,
      allDay: has(input, 'allDay') ? input['allDay'] : event.allDay,
      recurrenceRule: has(input, 'recurrenceRule') ? input['recurrenceRule'] : event.recurrenceRule,
    }
    const times = validateTimes(merged)
    if ('issues' in times) throw calendarValidation(times.issues)
    const rule = times.value.recurrence ? formatRule(times.value.recurrence) : null
    const timesChanged =
      times.value.startsAt.getTime() !== event.startsAt.getTime() ||
      times.value.endsAt.getTime() !== event.endsAt.getTime() ||
      times.value.timezone !== event.timezone ||
      times.value.allDay !== event.allDay ||
      (rule ?? null) !== (event.recurrenceRule ?? null)
    const patch: Parameters<EventStore['update']>[3] = {}
    if (has(input, 'title')) patch.title = requiredTitle(input['title'])
    if (has(input, 'description'))
      patch.description = optionalText(input['description'], 'description', 4000)
    if (has(input, 'status')) {
      const status = input['status']
      if (status !== 'TENTATIVE' && status !== 'CONFIRMED')
        throw failure(
          'status',
          'INVALID',
          'Estado: TENTATIVE ou CONFIRMED (para cancelar, use /cancel).'
        )
      patch.status = status
    }
    if (timesChanged) {
      const active = await this.bookings.activeOfEvent(scope, event.id, this.clock.now())
      const exceptions = await this.events.exceptions(scope, [event.id])
      const recurring = Boolean(event.recurrenceRule) || Boolean(rule)
      if (recurring && active.length > 0)
        throw ApiError.conflict(
          'SERIES_HAS_BOOKINGS',
          'A série tem reservas: cancele-as antes de mudar o horário ou a repetição.'
        )
      if (recurring && exceptions.length > 0)
        throw ApiError.conflict(
          'SERIES_HAS_EXCEPTIONS',
          'A série tem excepções que deixariam de corresponder: edite «esta e as seguintes».'
        )
      patch.startsAt = times.value.startsAt
      patch.endsAt = times.value.endsAt
      patch.timezone = times.value.timezone
      patch.allDay = times.value.allDay
      patch.recurrenceRule = rule
      try {
        for (const booking of active) {
          await this.bookings.move(scope, booking.id, times.value.startsAt, times.value.endsAt)
        }
      } catch (error) {
        if (error instanceof BookingCollision) throw unavailable()
        throw error
      }
    }
    const updated = await this.events.update(scope, event.id, event.version, patch)
    if (!updated) throw ApiError.versionConflict(event.version)
    return eventView(updated)
  }

  private async updateThis(
    scope: Scope,
    event: EventRecord,
    occurrence: Date,
    input: Record<string, unknown>
  ) {
    const exceptions = await this.events.exceptions(scope, [event.id])
    const existing = exceptions.find((x) => x.occurrenceStart.getTime() === occurrence.getTime())
    if (existing?.kind === 'CANCELLED')
      throw ApiError.conflict('OCCURRENCE_CANCELLED', 'Esta ocorrência foi cancelada.')
    const original = expand(
      {
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timezone: event.timezone,
        allDay: event.allDay,
        rule: ruleOf(event),
      },
      occurrence,
      new Date(occurrence.getTime() + 1),
      1
    )[0]
    if (!original) throw ApiError.notFound()
    const curStart = existing?.startsAt ?? original.startsAt
    const curEnd = existing?.endsAt ?? original.endsAt
    let startsAt = curStart
    let endsAt = curEnd
    if (has(input, 'startsAt')) {
      const date = toDate(input['startsAt'])
      if (!date) throw failure('startsAt', 'INVALID', 'Início inválido.')
      startsAt = date
      endsAt = new Date(date.getTime() + (curEnd.getTime() - curStart.getTime()))
    }
    if (has(input, 'endsAt')) {
      const date = toDate(input['endsAt'])
      if (!date) throw failure('endsAt', 'INVALID', 'Fim inválido.')
      endsAt = date
    }
    if (endsAt.getTime() <= startsAt.getTime())
      throw failure('endsAt', 'INVALID_RANGE', 'O fim tem de ser depois do início.')
    if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_HOURS * 3_600_000)
      throw failure('endsAt', 'TOO_LONG', 'Um evento não dura mais de 31 dias.')
    const title = has(input, 'title') ? requiredTitle(input['title']) : (existing?.title ?? null)
    const timesChanged =
      startsAt.getTime() !== curStart.getTime() || endsAt.getTime() !== curEnd.getTime()
    if (timesChanged) {
      const active = await this.bookings.activeOfEvent(scope, event.id, this.clock.now())
      const booked = active.filter((b) => keyOf(b.occurrenceStart) === occurrence.getTime())
      try {
        for (const booking of booked) await this.bookings.move(scope, booking.id, startsAt, endsAt)
      } catch (error) {
        if (error instanceof BookingCollision) throw unavailable()
        throw error
      }
    }
    await this.events.upsertException(scope, {
      eventId: event.id,
      occurrenceStart: occurrence,
      kind: 'MODIFIED',
      title,
      startsAt,
      endsAt,
    })
    return eventView(event)
  }

  /** «Esta e as seguintes»: a série divide-se; a parte antiga acaba antes da ocorrência e a nova herda tudo o resto. */
  private async updateFuture(
    scope: Scope,
    event: EventRecord,
    point: Date,
    input: Record<string, unknown>
  ) {
    if (point.getTime() === event.startsAt.getTime()) return this.updateAll(scope, event, input)
    if (has(input, 'timezone') && input['timezone'] !== event.timezone)
      throw failure('timezone', 'NOT_ALLOWED', 'O fuso não muda a partir de uma ocorrência.')
    if (has(input, 'allDay') && input['allDay'] !== event.allDay)
      throw failure('allDay', 'NOT_ALLOWED', 'Dia inteiro não muda a partir de uma ocorrência.')
    const duration = event.endsAt.getTime() - event.startsAt.getTime()
    let startsAt = point
    let endsAt = new Date(point.getTime() + duration)
    if (has(input, 'startsAt')) {
      const date = toDate(input['startsAt'])
      if (!date) throw failure('startsAt', 'INVALID', 'Início inválido.')
      startsAt = date
      endsAt = new Date(date.getTime() + duration)
    }
    if (has(input, 'endsAt')) {
      const date = toDate(input['endsAt'])
      if (!date) throw failure('endsAt', 'INVALID', 'Fim inválido.')
      endsAt = date
    }
    if (endsAt.getTime() <= startsAt.getTime())
      throw failure('endsAt', 'INVALID_RANGE', 'O fim tem de ser depois do início.')
    const oldRule = ruleOf(event)
    if (!oldRule) throw ApiError.notFound()
    const before = occurrencesBefore(event, point)
    let newRuleText: string | null
    if (has(input, 'recurrenceRule')) {
      const raw = input['recurrenceRule']
      if (raw === null || raw === '') newRuleText = null
      else {
        const parsed =
          typeof raw === 'string' ? parseRule(raw.trim()) : { error: 'Regra inválida.' }
        if ('error' in parsed) throw failure('recurrenceRule', 'INVALID_RULE', parsed.error)
        newRuleText = formatRule(parsed.rule)
      }
    } else {
      newRuleText = formatRule({
        ...oldRule,
        count: oldRule.count === null ? null : Math.max(1, oldRule.count - before),
      })
    }
    const shapeChanged =
      startsAt.getTime() !== point.getTime() ||
      endsAt.getTime() - startsAt.getTime() !== duration ||
      has(input, 'recurrenceRule')
    const now = this.clock.now()
    const activeBookings = await this.bookings.activeOfEvent(scope, event.id, now)
    const futureBookings = activeBookings.filter(
      (b) => b.occurrenceStart && b.occurrenceStart.getTime() >= point.getTime()
    )
    const allExceptions = await this.events.exceptions(scope, [event.id])
    const futureExceptions = allExceptions.filter(
      (x) => x.occurrenceStart.getTime() >= point.getTime()
    )
    if (shapeChanged && futureBookings.length > 0)
      throw ApiError.conflict(
        'SERIES_HAS_BOOKINGS',
        'As ocorrências seguintes têm reservas: cancele-as antes de mudar o horário ou a repetição.'
      )
    if (shapeChanged && futureExceptions.length > 0)
      throw ApiError.conflict(
        'SERIES_HAS_EXCEPTIONS',
        'As ocorrências seguintes têm excepções que deixariam de corresponder.'
      )
    // A parte antiga acaba um segundo antes da ocorrência.
    await this.events.setRule(
      scope,
      event.id,
      formatRule({ ...oldRule, count: null, until: new Date(point.getTime() - 1000) })
    )
    const created = await this.events.insert(scope, {
      calendarId: event.calendarId,
      title: has(input, 'title') ? requiredTitle(input['title']) : event.title,
      description: has(input, 'description')
        ? optionalText(input['description'], 'description', 4000)
        : event.description,
      startsAt,
      endsAt,
      timezone: event.timezone,
      allDay: event.allDay,
      recurrenceRule: newRuleText,
      status: event.status,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
    })
    await this.events.copyParticipants(scope, event.id, created.id)
    await this.events.moveExceptions(scope, event.id, created.id, point)
    await this.bookings.repoint(scope, event.id, created.id, point)
    return eventView(created)
  }

  // --- cancelamento --------------------------------------------------------------------------------

  /** Cancela o evento, uma ocorrência ou esta e as seguintes; liberta as reservas e avisa os participantes. */
  async cancel(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>
  ): Promise<EventView> {
    const viewer = viewerOf(context)
    const scopeKind = scopeOf(input)
    return this.uow.run(async (scope) => {
      const event = await this.visibleEvent(scope, viewer, id, true)
      if (event.status === 'CANCELLED') return eventView(event)
      let kind: EditScope = scopeKind
      let point: Date | null = null
      if (kind !== 'ALL') {
        if (!ruleOf(event))
          throw failure(
            'scope',
            'NOT_RECURRING',
            'Só se cancela uma ocorrência de um evento que se repete.'
          )
        point = occurrenceOf(input)
        if (!isGenuineOccurrence(event, point))
          throw failure(
            'occurrenceStart',
            'INVALID_OCCURRENCE',
            'Esta não é uma ocorrência da série.'
          )
        if (kind === 'FUTURE' && point.getTime() === event.startsAt.getTime()) kind = 'ALL'
      }
      let result: EventRecord = event
      if (kind === 'ALL') {
        await this.events.cancel(scope, event.id)
        await this.bookings.cancelFor(scope, event.id, {}, 'EVENT_CANCELLED')
        result = { ...event, status: 'CANCELLED', version: event.version + 1 }
      } else if (kind === 'THIS' && point) {
        await this.events.upsertException(scope, {
          eventId: event.id,
          occurrenceStart: point,
          kind: 'CANCELLED',
          title: null,
          startsAt: null,
          endsAt: null,
        })
        await this.bookings.cancelFor(
          scope,
          event.id,
          { occurrenceStart: point },
          'EVENT_CANCELLED'
        )
      } else if (point) {
        const rule = ruleOf(event)
        if (rule) {
          await this.events.setRule(
            scope,
            event.id,
            formatRule({ ...rule, count: null, until: new Date(point.getTime() - 1000) })
          )
        }
        await this.bookings.cancelFor(scope, event.id, { atOrAfter: point }, 'EVENT_CANCELLED')
      }
      const participants = await this.events.participants(scope, event.id)
      const recipients = participants
        .filter(
          (p) =>
            p.membershipId && p.membershipId !== viewer.membershipId && p.response !== 'DECLINED'
        )
        .map((p) => p.membershipId as string)
      await this.outbox.append(scope, {
        aggregateType: 'calendar_event',
        aggregateId: event.id,
        aggregateVersion: result.version,
        eventType: 'calendar.event.cancelled',
        payload: {
          eventId: event.id,
          title: event.title,
          scope: kind,
          occurrenceStart: point ? point.toISOString() : null,
          startsAt: (point ?? event.startsAt).toISOString(),
          recipients,
        },
        correlationId: context.correlationId,
      })
      return eventView(result)
    }, context)
  }

  // --- origem (outros módulos) ---------------------------------------------------------------------

  /** Cria ou actualiza o evento que um módulo (formação, escola, clínica, projectos…) mantém para um registo seu. */
  async upsertSourced(context: TenantContext, input: Record<string, unknown>): Promise<EventView> {
    const sourceType = optionalText(input['sourceType'], 'sourceType', 50)
    const sourceId = optionalText(input['sourceId'], 'sourceId', 64)
    if (!sourceType || !sourceId)
      throw failure('sourceType', 'REQUIRED', 'Indique sourceType e sourceId.')
    return this.uow.run(async (scope) => {
      const existing = await this.events.findBySource(scope, sourceType, sourceId)
      if (!existing) return this.create(context, input)
      const patch = { ...input }
      for (const key of ['calendarId', 'sourceType', 'sourceId']) delete patch[key]
      return this.update(context, existing.id, {
        ...patch,
        version: existing.version,
        scope: 'ALL',
      })
    }, context)
  }

  async cancelSourced(context: TenantContext, sourceType: string, sourceId: string): Promise<void> {
    await this.uow.run(async (scope) => {
      const existing = await this.events.findBySource(scope, sourceType, sourceId)
      if (existing) await this.cancel(context, existing.id, { scope: 'ALL' })
    }, context)
  }

  // --- participantes -------------------------------------------------------------------------------

  async addParticipant(
    context: TenantContext,
    eventId: string,
    input: Record<string, unknown>
  ): Promise<ParticipantView> {
    const viewer = viewerOf(context)
    const membershipId = typeof input['membershipId'] === 'string' ? input['membershipId'] : null
    const partyId = typeof input['partyId'] === 'string' ? input['partyId'] : null
    if ((membershipId === null) === (partyId === null))
      throw failure('membershipId', 'INVALID', 'Indique membershipId ou partyId (um só).')
    return this.uow.run(async (scope) => {
      const event = await this.visibleEvent(scope, viewer, eventId, true)
      if (event.status === 'CANCELLED')
        throw ApiError.conflict('EVENT_CANCELLED', 'O evento está cancelado.')
      if (membershipId && !(await this.events.membershipExists(scope, membershipId)))
        throw failure('membershipId', 'NOT_FOUND', 'Membro desconhecido ou inactivo.')
      if (partyId && !(await this.events.partyExists(scope, partyId)))
        throw failure('partyId', 'NOT_FOUND', 'Pessoa ou entidade desconhecida.')
      // Uma sala só comporta a sua capacidade: a mais pequena entre as reservadas.
      const capacity = await this.bookings.smallestCapacity(scope, eventId, this.clock.now())
      if (capacity !== null) {
        const current = await this.events.participants(scope, eventId)
        const count = current.length
        if (count + 1 > capacity)
          throw failure(
            'participants',
            'CAPACITY_EXCEEDED',
            `A capacidade do recurso reservado é ${capacity}.`
          )
      }
      const added = await this.events.addParticipant(scope, { eventId, membershipId, partyId })
      if (!added) throw ApiError.conflict('PARTICIPANT_EXISTS', 'Já é participante deste evento.')
      return participantView(added)
    }, context)
  }

  async removeParticipant(context: TenantContext, eventId: string, id: string): Promise<void> {
    const viewer = viewerOf(context)
    await this.uow.run(async (scope) => {
      await this.visibleEvent(scope, viewer, eventId)
      if (!(await this.events.removeParticipant(scope, eventId, id))) throw ApiError.notFound()
    }, context)
  }

  /** Cada pessoa responde só por si. */
  async respond(
    context: TenantContext,
    eventId: string,
    input: Record<string, unknown>
  ): Promise<ParticipantView> {
    const viewer = viewerOf(context)
    const response = input['response']
    if (!(RESPONSES as readonly unknown[]).includes(response) || response === 'PENDING')
      throw failure('response', 'INVALID', 'Resposta: ACCEPTED ou DECLINED.')
    return this.uow.run(async (scope) => {
      await this.visibleEvent(scope, viewer, eventId)
      const updated = await this.events.respond(
        scope,
        eventId,
        viewer.membershipId,
        response as ParticipantResponse
      )
      if (!updated) throw ApiError.notFound()
      return participantView(updated)
    }, context)
  }
}

// --- reservas ----------------------------------------------------------------------------------------

/**
 * Reservas de recursos. Quem decide a colisão é a restrição de exclusão da base de dados; a verificação prévia só
 * serve para dar uma mensagem útil. Uma reserva provisória (HELD) vence ao fim do prazo e liberta o horário.
 */
export class BookingUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly bookings: BookingStore,
    private readonly events: EventStore,
    private readonly calendars: CalendarUseCases,
    private readonly resources: ResourceUseCases,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  async create(
    context: TenantContext,
    input: Record<string, unknown>
  ): Promise<{ bookings: BookingView[]; skipped: number }> {
    const viewer = viewerOf(context)
    if (typeof input['eventId'] !== 'string')
      throw failure('eventId', 'REQUIRED', 'Indique o evento.')
    if (typeof input['resourceId'] !== 'string')
      throw failure('resourceId', 'REQUIRED', 'Indique o recurso.')
    const eventId = input['eventId']
    const resourceId = input['resourceId']
    const hold = input['hold'] === true
    const holdMinutes = input['holdMinutes'] ?? 15
    if (
      hold &&
      (typeof holdMinutes !== 'number' ||
        !Number.isInteger(holdMinutes) ||
        holdMinutes < 1 ||
        holdMinutes > MAX_HOLD_MINUTES)
    )
      throw failure('holdMinutes', 'INVALID', `Entre 1 e ${MAX_HOLD_MINUTES} minutos.`)
    const horizon = input['horizonDays'] ?? DEFAULT_BOOKING_HORIZON_DAYS
    if (
      typeof horizon !== 'number' ||
      !Number.isInteger(horizon) ||
      horizon < 1 ||
      horizon > MAX_BOOKING_HORIZON_DAYS
    )
      throw failure('horizonDays', 'INVALID', `Entre 1 e ${MAX_BOOKING_HORIZON_DAYS} dias.`)
    const only = input['occurrenceStart'] === undefined ? null : toDate(input['occurrenceStart'])
    if (input['occurrenceStart'] !== undefined && !only)
      throw failure('occurrenceStart', 'INVALID', 'Início da ocorrência inválido.')

    return this.uow.run(async (scope) => {
      const now = this.clock.now()
      const resource = await this.resources.visible(scope, viewer, resourceId, true)
      if (!resource.active)
        throw ApiError.conflict('RESOURCE_INACTIVE', 'O recurso está desactivado.')
      const event = await this.events.lock(scope, eventId)
      if (!event) throw ApiError.notFound()
      await this.calendars.visible(scope, viewer, event.calendarId)
      if (event.status === 'CANCELLED')
        throw ApiError.conflict('EVENT_CANCELLED', 'O evento está cancelado.')

      const attending = await this.events.participants(scope, eventId)
      const participants = attending.length
      if (participants > resource.capacity)
        throw failure(
          'resourceId',
          'CAPACITY_EXCEEDED',
          `O evento tem ${participants} participantes e o recurso comporta ${resource.capacity}.`
        )

      // Que ocorrências reservar.
      let targets: { occurrenceStart: Date | null; startsAt: Date; endsAt: Date }[]
      if (!ruleOf(event)) {
        if (only) throw failure('occurrenceStart', 'NOT_RECURRING', 'O evento não se repete.')
        targets = [{ occurrenceStart: null, startsAt: event.startsAt, endsAt: event.endsAt }]
      } else {
        const exceptions = await this.events.exceptions(scope, [event.id])
        if (only) {
          if (!isGenuineOccurrence(event, only))
            throw failure(
              'occurrenceStart',
              'INVALID_OCCURRENCE',
              'Esta não é uma ocorrência da série.'
            )
          const found = resolveOccurrences(
            event,
            exceptions,
            new Date(only.getTime() - 86_400_000 * 31),
            new Date(only.getTime() + 86_400_000 * 31)
          ).find((o) => o.occurrenceStart?.getTime() === only.getTime())
          if (!found)
            throw ApiError.conflict('OCCURRENCE_CANCELLED', 'Esta ocorrência foi cancelada.')
          targets = [{ occurrenceStart: only, startsAt: found.startsAt, endsAt: found.endsAt }]
        } else {
          const from = now.getTime() > event.startsAt.getTime() ? now : event.startsAt
          const to = new Date(from.getTime() + horizon * 86_400_000)
          targets = resolveOccurrences(event, exceptions, from, to, MAX_BOOKED_OCCURRENCES + 1)
            .filter((o) => o.occurrenceStart)
            .map((o) => ({
              occurrenceStart: o.occurrenceStart,
              startsAt: o.startsAt,
              endsAt: o.endsAt,
            }))
        }
      }
      if (targets.length === 0)
        throw failure(
          'horizonDays',
          'NO_OCCURRENCES',
          'Não há ocorrências para reservar neste período.'
        )
      if (targets.length > MAX_BOOKED_OCCURRENCES)
        throw failure(
          'horizonDays',
          'TOO_MANY_OCCURRENCES',
          `Reserve até ${MAX_BOOKED_OCCURRENCES} ocorrências de cada vez: reduza o período.`
        )

      const booked = await this.bookings.existing(scope, eventId, resourceId)
      const already = new Set(booked.map((b) => keyOf(b.occurrenceStart)))
      const pending = targets.filter((t) => !already.has(keyOf(t.occurrenceStart)))
      if (pending.length === 0) return { bookings: [], skipped: targets.length }

      await this.bookings.expireHolds(scope, resourceId, now)
      const clashes: { path: string; message: string }[] = []
      for (const [i, t] of pending.entries()) {
        const conflicts = await this.bookings.conflicts(scope, resourceId, t.startsAt, t.endsAt)
        if (conflicts.length > 0)
          clashes.push({
            path: `occurrences.${i}`,
            message: `Ocupado entre ${conflicts[0]?.startsAt.toISOString()} e ${conflicts[0]?.endsAt.toISOString()}.`,
          })
      }
      if (clashes.length > 0) throw unavailable(clashes)

      const created: BookingRecord[] = []
      try {
        for (const t of pending) {
          const booking = await this.bookings.insert(scope, {
            eventId,
            resourceId,
            occurrenceStart: t.occurrenceStart,
            startsAt: t.startsAt,
            endsAt: t.endsAt,
            status: hold ? 'HELD' : 'CONFIRMED',
            expiresAt: hold ? new Date(now.getTime() + (holdMinutes as number) * 60_000) : null,
          })
          if (booking) created.push(booking)
        }
      } catch (error) {
        if (error instanceof BookingCollision) throw unavailable()
        throw error
      }
      return {
        bookings: created.map((b) => bookingView(b)),
        skipped: targets.length - pending.length,
      }
    }, context)
  }

  async confirm(context: TenantContext, id: string): Promise<BookingView> {
    const viewer = viewerOf(context)
    return this.uow.run(async (scope) => {
      const booking = await this.bookings.lock(scope, id)
      if (!booking) throw ApiError.notFound()
      await this.resources.visible(scope, viewer, booking.resourceId)
      if (booking.status === 'CONFIRMED') return bookingView(booking)
      if (booking.status === 'CANCELLED')
        throw ApiError.conflict(
          booking.cancelReason === 'EXPIRED' ? 'HOLD_EXPIRED' : 'BOOKING_CANCELLED',
          booking.cancelReason === 'EXPIRED'
            ? 'A reserva provisória venceu.'
            : 'A reserva está cancelada.'
        )
      if (booking.expiresAt && booking.expiresAt.getTime() <= this.clock.now().getTime())
        throw ApiError.conflict('HOLD_EXPIRED', 'A reserva provisória venceu.')
      return bookingView(await this.bookings.confirm(scope, id))
    }, context)
  }

  /** Cancelar liberta o horário, preserva o evento e avisa os participantes. */
  async cancel(context: TenantContext, id: string): Promise<BookingView> {
    const viewer = viewerOf(context)
    return this.uow.run(async (scope) => {
      const booking = await this.bookings.lock(scope, id)
      if (!booking) throw ApiError.notFound()
      const resource = await this.resources.visible(scope, viewer, booking.resourceId)
      const event = await this.events.find(scope, booking.eventId)
      if (!event) throw ApiError.notFound()
      await this.calendars.visible(scope, viewer, event.calendarId)
      if (booking.status === 'CANCELLED') return bookingView(booking)
      const cancelled = await this.bookings.cancel(scope, id, 'CANCELLED')
      const participants = await this.events.participants(scope, event.id)
      await this.outbox.append(scope, {
        aggregateType: 'resource_booking',
        aggregateId: id,
        aggregateVersion: cancelled.version,
        eventType: 'calendar.booking.cancelled',
        payload: {
          bookingId: id,
          eventId: event.id,
          title: event.title,
          resourceName: resource.name,
          startsAt: booking.startsAt.toISOString(),
          recipients: participants
            .filter(
              (p) =>
                p.membershipId &&
                p.membershipId !== viewer.membershipId &&
                p.response !== 'DECLINED'
            )
            .map((p) => p.membershipId as string),
        },
        correlationId: context.correlationId,
      })
      return bookingView(cancelled)
    }, context)
  }

  async list(
    context: TenantContext,
    query: { from: unknown; to: unknown; resourceId?: string | null; eventId?: string | null }
  ): Promise<{ items: BookingView[]; asOf: string }> {
    const viewer = viewerOf(context)
    const range = validateRange(query.from, query.to)
    if ('issue' in range) throw calendarValidation([range.issue])
    return this.uow.run(async (scope) => {
      if (query.resourceId) await this.resources.visible(scope, viewer, query.resourceId)
      const now = this.clock.now()
      const rows = await this.bookings.list(
        scope,
        viewer,
        {
          resourceId: query.resourceId ?? null,
          eventId: query.eventId ?? null,
          from: range.from,
          to: range.to,
        },
        now
      )
      const visible = await this.resources.list(context)
      const allowed = new Set(visible.map((r) => r.id))
      return {
        items: rows
          .filter((b) => allowed.has(b.resourceId))
          .map((b) => bookingView(b, b.eventTitle)),
        asOf: now.toISOString(),
      }
    }, context)
  }

  /** Os intervalos ocupados de um recurso (sem revelar o que se faz neles). */
  async availability(
    context: TenantContext,
    resourceId: string,
    from: unknown,
    to: unknown
  ): Promise<{
    resourceId: string
    busy: { id: string; startsAt: string; endsAt: string; status: string; mine: boolean }[]
    asOf: string
  }> {
    const viewer = viewerOf(context)
    const range = validateRange(from, to)
    if ('issue' in range) throw calendarValidation([range.issue])
    return this.uow.run(async (scope) => {
      await this.resources.visible(scope, viewer, resourceId)
      const now = this.clock.now()
      const busy = await this.bookings.busy(scope, viewer, resourceId, range.from, range.to, now)
      return {
        resourceId,
        busy: busy.map((b) => ({
          id: b.id,
          startsAt: b.startsAt.toISOString(),
          endsAt: b.endsAt.toISOString(),
          status: b.status,
          mine: b.mine,
        })),
        asOf: now.toISOString(),
      }
    }, context)
  }
}
