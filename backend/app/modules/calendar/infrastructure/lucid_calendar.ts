import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type {
  BookingStatus,
  CalendarVisibility,
  EventStatus,
  Holiday,
  ParticipantResponse,
  ResourceType,
  WorkingHours,
} from '#modules/calendar/domain/calendar'
import {
  BookingCollision,
  type BookingListItem,
  type BookingRecord,
  type BookingStore,
  type BusinessCalendarRecord,
  type BusinessCalendarStore,
  type CalendarRecord,
  type CalendarStore,
  type EventRecord,
  type EventStore,
  type ExceptionRecord,
  type NewBooking,
  type NewBusinessCalendar,
  type NewCalendar,
  type NewEvent,
  type NewResource,
  type ParticipantRecord,
  type ResourceRecord,
  type ResourceStore,
  type Viewer,
} from '#modules/calendar/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

type Bind = never[]
async function query<T>(scope: TenantScope, sql: string, bindings: unknown[] = []): Promise<T[]> {
  const result = await trxOf(scope).rawQuery(sql, bindings as Bind)
  return result.rows as T[]
}

const json = (value: unknown) => JSON.stringify(value)
const code = (error: unknown) => (error as { code?: string } | null)?.code

/** O predicado SQL que diz se `viewer` vê o calendário `alias`. */
const visibleSql = (alias: string) =>
  `(${alias}.visibility = 'TENANT'
     OR (${alias}.visibility = 'PRIVATE' AND ${alias}.owner_membership_id = ?)
     OR (${alias}.visibility = 'UNIT' AND (? OR ${alias}.unit_id::text = ANY(string_to_array(?, ',')))))`
const visibleBind = (viewer: Viewer) => [
  viewer.membershipId,
  viewer.allUnits,
  viewer.unitIds.join(','),
]

// --- calendários -------------------------------------------------------------------------------------

interface CalendarRow {
  id: string
  name: string
  owner_membership_id: string | null
  unit_id: string | null
  timezone: string
  visibility: CalendarVisibility
  version: number
  created_at: Date
}
const CAL = 'id, name, owner_membership_id, unit_id, timezone, visibility, version, created_at'
const toCalendar = (r: CalendarRow): CalendarRecord => ({
  id: r.id,
  name: r.name,
  ownerMembershipId: r.owner_membership_id,
  unitId: r.unit_id,
  timezone: r.timezone,
  visibility: r.visibility,
  version: r.version,
  createdAt: r.created_at,
})

export class LucidCalendarStore implements CalendarStore {
  async insert(scope: TenantScope, v: NewCalendar) {
    const rows = await query<CalendarRow>(
      scope,
      `insert into calendars (tenant_id, name, owner_membership_id, unit_id, timezone, visibility,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?) returning ${CAL}`,
      [
        tenantOf(scope),
        v.name,
        v.ownerMembershipId,
        v.unitId,
        v.timezone,
        v.visibility,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toCalendar(rows[0] as CalendarRow)
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<CalendarRow>(scope, `select ${CAL} from calendars where id = ?`, [id])
    return rows[0] ? toCalendar(rows[0]) : null
  }

  async lock(scope: TenantScope, id: string) {
    const rows = await query<CalendarRow>(
      scope,
      `select ${CAL} from calendars where id = ? for update`,
      [id]
    )
    return rows[0] ? toCalendar(rows[0]) : null
  }

  async list(scope: TenantScope) {
    const rows = await query<CalendarRow>(scope, `select ${CAL} from calendars order by name, id`)
    return rows.map(toCalendar)
  }

  async update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewCalendar, 'ownerMembershipId'>
  ) {
    const rows = await query<CalendarRow>(
      scope,
      `update calendars set name = ?, unit_id = ?, timezone = ?, visibility = ?, version = version + 1,
         updated_at = now(), updated_by_membership_id = ?
       where id = ? and version = ? returning ${CAL}`,
      [v.name, v.unitId, v.timezone, v.visibility, actorOf(scope), id, version]
    )
    return rows[0] ? toCalendar(rows[0]) : null
  }

  async remove(scope: TenantScope, id: string) {
    const rows = await query<{ id: string }>(
      scope,
      `delete from calendars where id = ? returning id`,
      [id]
    )
    return rows.length > 0
  }

  async hasEvents(scope: TenantScope, id: string) {
    const rows = await query<{ n: number }>(
      scope,
      `select count(*)::int as n from calendar_events where calendar_id = ?`,
      [id]
    )
    return (rows[0]?.n ?? 0) > 0
  }
}

// --- recursos ----------------------------------------------------------------------------------------

interface ResourceRow {
  id: string
  organization_id: string
  unit_id: string | null
  code: string
  name: string
  type: ResourceType
  capacity: number
  active: boolean
  version: number
  created_at: Date
}
const RES = 'id, organization_id, unit_id, code, name, type, capacity, active, version, created_at'
const toResource = (r: ResourceRow): ResourceRecord => ({
  id: r.id,
  organizationId: r.organization_id,
  unitId: r.unit_id,
  code: r.code,
  name: r.name,
  type: r.type,
  capacity: r.capacity,
  active: r.active,
  version: r.version,
  createdAt: r.created_at,
})

export class LucidResourceStore implements ResourceStore {
  async insert(scope: TenantScope, v: NewResource) {
    const rows = await query<ResourceRow>(
      scope,
      `insert into resources (tenant_id, organization_id, unit_id, code, name, type, capacity, active,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, code) do nothing returning ${RES}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.unitId,
        v.code,
        v.name,
        v.type,
        v.capacity,
        v.active,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return rows[0] ? toResource(rows[0]) : null
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<ResourceRow>(scope, `select ${RES} from resources where id = ?`, [id])
    return rows[0] ? toResource(rows[0]) : null
  }

  async lock(scope: TenantScope, id: string) {
    const rows = await query<ResourceRow>(
      scope,
      `select ${RES} from resources where id = ? for update`,
      [id]
    )
    return rows[0] ? toResource(rows[0]) : null
  }

  async list(scope: TenantScope) {
    const rows = await query<ResourceRow>(scope, `select ${RES} from resources order by code, id`)
    return rows.map(toResource)
  }

  async update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewResource, 'organizationId' | 'code'>
  ) {
    const rows = await query<ResourceRow>(
      scope,
      `update resources set unit_id = ?, name = ?, type = ?, capacity = ?, active = ?, version = version + 1,
         updated_at = now(), updated_by_membership_id = ?
       where id = ? and version = ? returning ${RES}`,
      [v.unitId, v.name, v.type, v.capacity, v.active, actorOf(scope), id, version]
    )
    return rows[0] ? toResource(rows[0]) : null
  }

  async remove(scope: TenantScope, id: string) {
    const rows = await query<{ id: string }>(
      scope,
      `delete from resources where id = ? returning id`,
      [id]
    )
    return rows.length > 0
  }

  async organizationExists(scope: TenantScope, id: string) {
    const rows = await query(scope, `select 1 from organizations where id = ?`, [id])
    return rows.length > 0
  }

  async unitExists(scope: TenantScope, id: string) {
    const rows = await query(scope, `select 1 from organization_units where id = ?`, [id])
    return rows.length > 0
  }
}

// --- eventos -----------------------------------------------------------------------------------------

interface EventRow {
  id: string
  calendar_id: string
  title: string
  description: string | null
  starts_at: Date
  ends_at: Date
  timezone: string
  all_day: boolean
  recurrence_rule: string | null
  status: EventStatus
  source_type: string | null
  source_id: string | null
  created_by_membership_id: string | null
  version: number
  created_at: Date
}
const EV = `id, calendar_id, title, description, starts_at, ends_at, timezone, all_day, recurrence_rule, status,
  source_type, source_id, created_by_membership_id, version, created_at`
const toEvent = (r: EventRow): EventRecord => ({
  id: r.id,
  calendarId: r.calendar_id,
  title: r.title,
  description: r.description,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  timezone: r.timezone,
  allDay: r.all_day,
  recurrenceRule: r.recurrence_rule,
  status: r.status,
  sourceType: r.source_type,
  sourceId: r.source_id,
  createdByMembershipId: r.created_by_membership_id,
  version: r.version,
  createdAt: r.created_at,
})

interface ExceptionRow {
  id: string
  event_id: string
  occurrence_start: Date
  kind: 'CANCELLED' | 'MODIFIED'
  title: string | null
  starts_at: Date | null
  ends_at: Date | null
}
const EXC = 'id, event_id, occurrence_start, kind, title, starts_at, ends_at'
const toException = (r: ExceptionRow): ExceptionRecord => ({
  id: r.id,
  eventId: r.event_id,
  occurrenceStart: r.occurrence_start,
  kind: r.kind,
  title: r.title,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
})

interface ParticipantRow {
  id: string
  event_id: string
  membership_id: string | null
  party_id: string | null
  response: ParticipantResponse
}
const PART = 'id, event_id, membership_id, party_id, response'
const toParticipant = (r: ParticipantRow): ParticipantRecord => ({
  id: r.id,
  eventId: r.event_id,
  membershipId: r.membership_id,
  partyId: r.party_id,
  response: r.response,
})

export class LucidEventStore implements EventStore {
  async insert(scope: TenantScope, v: NewEvent) {
    const rows = await query<EventRow>(
      scope,
      `insert into calendar_events (tenant_id, calendar_id, title, description, starts_at, ends_at, timezone,
         all_day, recurrence_rule, status, source_type, source_id, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${EV}`,
      [
        tenantOf(scope),
        v.calendarId,
        v.title,
        v.description,
        v.startsAt,
        v.endsAt,
        v.timezone,
        v.allDay,
        v.recurrenceRule,
        v.status,
        v.sourceType,
        v.sourceId,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toEvent(rows[0] as EventRow)
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<EventRow>(scope, `select ${EV} from calendar_events where id = ?`, [
      id,
    ])
    return rows[0] ? toEvent(rows[0]) : null
  }

  async lock(scope: TenantScope, id: string) {
    const rows = await query<EventRow>(
      scope,
      `select ${EV} from calendar_events where id = ? for update`,
      [id]
    )
    return rows[0] ? toEvent(rows[0]) : null
  }

  async findBySource(scope: TenantScope, type: string, id: string) {
    const rows = await query<EventRow>(
      scope,
      `select ${EV} from calendar_events where source_type = ? and source_id = ?
       order by created_at limit 1`,
      [type, id]
    )
    return rows[0] ? toEvent(rows[0]) : null
  }

  async candidates(
    scope: TenantScope,
    viewer: Viewer,
    from: Date,
    to: Date,
    calendarId: string | null
  ) {
    const rows = await query<EventRow>(
      scope,
      `select ${EV.split(', ')
        .map((c) => `e.${c.trim()}`)
        .join(', ')}
         from calendar_events e join calendars c on c.id = e.calendar_id
        where ${visibleSql('c')}
          and (cast(? as text) is null or e.calendar_id::text = ?)
          and e.status <> 'CANCELLED'
          and (
            (e.recurrence_rule is null and e.starts_at < ? and e.ends_at > ?)
            or (e.recurrence_rule is not null and e.starts_at < ?)
            or exists (select 1 from calendar_event_exceptions x
                        where x.event_id = e.id and x.kind = 'MODIFIED' and x.starts_at < ? and x.ends_at > ?)
          )
        order by e.starts_at, e.id limit 2000`,
      [...visibleBind(viewer), calendarId, calendarId, to, from, to, to, from]
    )
    return rows.map(toEvent)
  }

  async update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Partial<Omit<NewEvent, 'calendarId' | 'sourceType' | 'sourceId'>>
  ) {
    const sets: string[] = []
    const bind: unknown[] = []
    const map: Record<string, unknown> = {
      title: v.title,
      description: v.description,
      starts_at: v.startsAt,
      ends_at: v.endsAt,
      timezone: v.timezone,
      all_day: v.allDay,
      recurrence_rule: v.recurrenceRule,
      status: v.status,
    }
    for (const [column, value] of Object.entries(map)) {
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      bind.push(value)
    }
    const rows = await query<EventRow>(
      scope,
      `update calendar_events set ${sets.length > 0 ? sets.join(', ') + ',' : ''} version = version + 1,
         updated_at = now(), updated_by_membership_id = ?
       where id = ? and version = ? returning ${EV}`,
      [...bind, actorOf(scope), id, version]
    )
    return rows[0] ? toEvent(rows[0]) : null
  }

  async setRule(scope: TenantScope, id: string, rule: string | null) {
    await query(
      scope,
      `update calendar_events set recurrence_rule = ?, version = version + 1, updated_at = now(),
         updated_by_membership_id = ? where id = ?`,
      [rule, actorOf(scope), id]
    )
  }

  async cancel(scope: TenantScope, id: string) {
    await query(
      scope,
      `update calendar_events set status = 'CANCELLED', version = version + 1, updated_at = now(),
         updated_by_membership_id = ? where id = ?`,
      [actorOf(scope), id]
    )
  }

  async exceptions(scope: TenantScope, eventIds: string[]) {
    if (eventIds.length === 0) return []
    const rows = await query<ExceptionRow>(
      scope,
      `select ${EXC} from calendar_event_exceptions where event_id::text = ANY(string_to_array(?, ','))
       order by occurrence_start`,
      [eventIds.join(',')]
    )
    return rows.map(toException)
  }

  async upsertException(scope: TenantScope, v: Omit<ExceptionRecord, 'id'>) {
    const rows = await query<ExceptionRow>(
      scope,
      `insert into calendar_event_exceptions (tenant_id, event_id, occurrence_start, kind, title, starts_at,
         ends_at, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (event_id, occurrence_start) do update
         set kind = excluded.kind, title = excluded.title, starts_at = excluded.starts_at,
             ends_at = excluded.ends_at, version = calendar_event_exceptions.version + 1,
             updated_at = now(), updated_by_membership_id = excluded.updated_by_membership_id
       returning ${EXC}`,
      [
        tenantOf(scope),
        v.eventId,
        v.occurrenceStart,
        v.kind,
        v.title,
        v.startsAt,
        v.endsAt,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toException(rows[0] as ExceptionRow)
  }

  async moveExceptions(scope: TenantScope, from: string, to: string, atOrAfter: Date) {
    const rows = await query<{ id: string }>(
      scope,
      `update calendar_event_exceptions set event_id = ?, updated_at = now()
        where event_id = ? and occurrence_start >= ? returning id`,
      [to, from, atOrAfter]
    )
    return rows.length
  }

  async participants(scope: TenantScope, eventId: string) {
    const rows = await query<ParticipantRow>(
      scope,
      `select ${PART} from event_participants where event_id = ? order by created_at, id`,
      [eventId]
    )
    return rows.map(toParticipant)
  }

  async addParticipant(
    scope: TenantScope,
    v: { eventId: string; membershipId: string | null; partyId: string | null }
  ) {
    const rows = await query<ParticipantRow>(
      scope,
      `insert into event_participants (tenant_id, event_id, membership_id, party_id,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) on conflict do nothing returning ${PART}`,
      [tenantOf(scope), v.eventId, v.membershipId, v.partyId, actorOf(scope), actorOf(scope)]
    )
    return rows[0] ? toParticipant(rows[0]) : null
  }

  async copyParticipants(scope: TenantScope, from: string, to: string) {
    await query(
      scope,
      `insert into event_participants (tenant_id, event_id, membership_id, party_id, response,
         created_by_membership_id, updated_by_membership_id)
       select tenant_id, ?, membership_id, party_id, response, ?, ? from event_participants where event_id = ?`,
      [to, actorOf(scope), actorOf(scope), from]
    )
  }

  async removeParticipant(scope: TenantScope, eventId: string, id: string) {
    const rows = await query<{ id: string }>(
      scope,
      `delete from event_participants where event_id = ? and id = ? returning id`,
      [eventId, id]
    )
    return rows.length > 0
  }

  async respond(
    scope: TenantScope,
    eventId: string,
    membershipId: string,
    response: ParticipantResponse
  ) {
    const rows = await query<ParticipantRow>(
      scope,
      `update event_participants set response = ?, version = version + 1, updated_at = now(),
         updated_by_membership_id = ? where event_id = ? and membership_id = ? returning ${PART}`,
      [response, actorOf(scope), eventId, membershipId]
    )
    return rows[0] ? toParticipant(rows[0]) : null
  }

  async membershipExists(scope: TenantScope, id: string) {
    const rows = await query(
      scope,
      `select 1 from tenant_memberships where id = ? and status = 'ACTIVE'`,
      [id]
    )
    return rows.length > 0
  }

  async partyExists(scope: TenantScope, id: string) {
    const rows = await query(scope, `select 1 from parties where id = ?`, [id])
    return rows.length > 0
  }
}

// --- reservas ----------------------------------------------------------------------------------------

interface BookingRow {
  id: string
  event_id: string
  resource_id: string
  occurrence_start: Date | null
  starts_at: Date
  ends_at: Date
  status: BookingStatus
  expires_at: Date | null
  cancel_reason: string | null
  version: number
  created_at: Date
}
const BK = `id, event_id, resource_id, occurrence_start, starts_at, ends_at, status, expires_at, cancel_reason,
  version, created_at`
const toBooking = (r: BookingRow): BookingRecord => ({
  id: r.id,
  eventId: r.event_id,
  resourceId: r.resource_id,
  occurrenceStart: r.occurrence_start,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  status: r.status,
  expiresAt: r.expires_at,
  cancelReason: r.cancel_reason,
  version: r.version,
  createdAt: r.created_at,
})

const bkAlias = (alias: string) =>
  BK.split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ')

export class LucidBookingStore implements BookingStore {
  async find(scope: TenantScope, id: string) {
    const rows = await query<BookingRow>(
      scope,
      `select ${BK} from resource_bookings where id = ?`,
      [id]
    )
    return rows[0] ? toBooking(rows[0]) : null
  }

  async lock(scope: TenantScope, id: string) {
    const rows = await query<BookingRow>(
      scope,
      `select ${BK} from resource_bookings where id = ? for update`,
      [id]
    )
    return rows[0] ? toBooking(rows[0]) : null
  }

  async expireHolds(scope: TenantScope, resourceId: string, now: Date) {
    const rows = await query<{ id: string }>(
      scope,
      `update resource_bookings set status = 'CANCELLED', cancel_reason = 'EXPIRED', expires_at = null,
         version = version + 1, updated_at = now()
        where resource_id = ? and status = 'HELD' and expires_at <= ? returning id`,
      [resourceId, now]
    )
    return rows.length
  }

  async conflicts(scope: TenantScope, resourceId: string, startsAt: Date, endsAt: Date) {
    const rows = await query<{ starts_at: Date; ends_at: Date }>(
      scope,
      `select starts_at, ends_at from resource_bookings
        where resource_id = ? and status in ('HELD', 'CONFIRMED') and starts_at < ? and ends_at > ?
        order by starts_at`,
      [resourceId, endsAt, startsAt]
    )
    return rows.map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at }))
  }

  async insert(scope: TenantScope, v: NewBooking) {
    try {
      const rows = await query<BookingRow>(
        scope,
        `insert into resource_bookings (tenant_id, event_id, resource_id, occurrence_start, starts_at, ends_at,
           status, expires_at, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${BK}`,
        [
          tenantOf(scope),
          v.eventId,
          v.resourceId,
          v.occurrenceStart,
          v.startsAt,
          v.endsAt,
          v.status,
          v.expiresAt,
          actorOf(scope),
          actorOf(scope),
        ]
      )
      return rows[0] ? toBooking(rows[0]) : null
    } catch (error) {
      // 23P01: restrição de exclusão (horário ocupado); 23505: já existe reserva activa desta ocorrência.
      if (code(error) === '23P01' || code(error) === '23505') throw new BookingCollision()
      throw error
    }
  }

  async confirm(scope: TenantScope, id: string) {
    const rows = await query<BookingRow>(
      scope,
      `update resource_bookings set status = 'CONFIRMED', expires_at = null, version = version + 1,
         updated_at = now(), updated_by_membership_id = ? where id = ? returning ${BK}`,
      [actorOf(scope), id]
    )
    return toBooking(rows[0] as BookingRow)
  }

  async cancel(scope: TenantScope, id: string, reason: string) {
    const rows = await query<BookingRow>(
      scope,
      `update resource_bookings set status = 'CANCELLED', cancel_reason = ?, expires_at = null,
         version = version + 1, updated_at = now(), updated_by_membership_id = ?
        where id = ? returning ${BK}`,
      [reason, actorOf(scope), id]
    )
    return toBooking(rows[0] as BookingRow)
  }

  async move(scope: TenantScope, id: string, startsAt: Date, endsAt: Date) {
    try {
      await query(
        scope,
        `update resource_bookings set starts_at = ?, ends_at = ?, version = version + 1, updated_at = now(),
           updated_by_membership_id = ? where id = ?`,
        [startsAt, endsAt, actorOf(scope), id]
      )
    } catch (error) {
      if (code(error) === '23P01') throw new BookingCollision()
      throw error
    }
  }

  async repoint(scope: TenantScope, from: string, to: string, atOrAfter: Date) {
    const rows = await query<{ id: string }>(
      scope,
      `update resource_bookings set event_id = ?, updated_at = now()
        where event_id = ? and status in ('HELD', 'CONFIRMED') and occurrence_start >= ? returning id`,
      [to, from, atOrAfter]
    )
    return rows.length
  }

  async activeOfEvent(scope: TenantScope, eventId: string, now: Date) {
    const rows = await query<BookingRow>(
      scope,
      `select ${BK} from resource_bookings
        where event_id = ? and (status = 'CONFIRMED' or (status = 'HELD' and expires_at > ?))
        order by starts_at`,
      [eventId, now]
    )
    return rows.map(toBooking)
  }

  async cancelFor(
    scope: TenantScope,
    eventId: string,
    filter: { occurrenceStart?: Date; atOrAfter?: Date },
    reason: string
  ) {
    const where: string[] = [`event_id = ?`, `status in ('HELD', 'CONFIRMED')`]
    const bind: unknown[] = [eventId]
    if (filter.occurrenceStart) {
      where.push('occurrence_start = ?')
      bind.push(filter.occurrenceStart)
    }
    if (filter.atOrAfter) {
      where.push('occurrence_start >= ?')
      bind.push(filter.atOrAfter)
    }
    const rows = await query<BookingRow>(
      scope,
      `update resource_bookings set status = 'CANCELLED', cancel_reason = ?, expires_at = null,
         version = version + 1, updated_at = now(), updated_by_membership_id = ?
        where ${where.join(' and ')} returning ${BK}`,
      [reason, actorOf(scope), ...bind]
    )
    return rows.map(toBooking)
  }

  async existing(scope: TenantScope, eventId: string, resourceId: string) {
    const rows = await query<{ occurrence_start: Date | null }>(
      scope,
      `select occurrence_start from resource_bookings
        where event_id = ? and resource_id = ? and status <> 'CANCELLED'`,
      [eventId, resourceId]
    )
    return rows.map((r) => ({ occurrenceStart: r.occurrence_start }))
  }

  async list(
    scope: TenantScope,
    viewer: Viewer,
    filter: { resourceId: string | null; eventId: string | null; from: Date; to: Date },
    now: Date
  ) {
    const rows = await query<BookingRow & { event_title: string | null }>(
      scope,
      `select ${bkAlias('b')},
              case when ${visibleSql('c')} then e.title end as event_title
         from resource_bookings b
         join calendar_events e on e.id = b.event_id
         join calendars c on c.id = e.calendar_id
        where (cast(? as text) is null or b.resource_id::text = ?)
          and (cast(? as text) is null or b.event_id::text = ?)
          and b.starts_at < ? and b.ends_at > ?
          and (b.status = 'CONFIRMED' or (b.status = 'HELD' and b.expires_at > ?))
        order by b.starts_at, b.id limit 1000`,
      [
        ...visibleBind(viewer),
        filter.resourceId,
        filter.resourceId,
        filter.eventId,
        filter.eventId,
        filter.to,
        filter.from,
        now,
      ]
    )
    return rows.map<BookingListItem>((r) => ({ ...toBooking(r), eventTitle: r.event_title }))
  }

  async busy(
    scope: TenantScope,
    viewer: Viewer,
    resourceId: string,
    from: Date,
    to: Date,
    now: Date
  ) {
    const rows = await query<{
      id: string
      starts_at: Date
      ends_at: Date
      status: BookingStatus
      mine: boolean
    }>(
      scope,
      `select b.id, b.starts_at, b.ends_at, b.status, (b.created_by_membership_id = ?) as mine
         from resource_bookings b
        where b.resource_id = ? and b.starts_at < ? and b.ends_at > ?
          and (b.status = 'CONFIRMED' or (b.status = 'HELD' and b.expires_at > ?))
        order by b.starts_at limit 1000`,
      [viewer.membershipId, resourceId, to, from, now]
    )
    return rows.map((r) => ({
      id: r.id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status,
      mine: r.mine,
    }))
  }

  async smallestCapacity(scope: TenantScope, eventId: string, now: Date) {
    const rows = await query<{ capacity: number | null }>(
      scope,
      `select min(r.capacity)::int as capacity
         from resource_bookings b join resources r on r.id = b.resource_id
        where b.event_id = ? and (b.status = 'CONFIRMED' or (b.status = 'HELD' and b.expires_at > ?))`,
      [eventId, now]
    )
    return rows[0]?.capacity ?? null
  }
}

// --- horário útil ------------------------------------------------------------------------------------

interface BusinessRow {
  id: string
  organization_id: string
  name: string
  timezone: string
  weekly_working_hours: WorkingHours
  holidays: Holiday[]
  version: number
  created_at: Date
}
const BUS =
  'id, organization_id, name, timezone, weekly_working_hours, holidays, version, created_at'
const toBusiness = (r: BusinessRow): BusinessCalendarRecord => ({
  id: r.id,
  organizationId: r.organization_id,
  name: r.name,
  timezone: r.timezone,
  weeklyWorkingHours: r.weekly_working_hours,
  holidays: r.holidays,
  version: r.version,
  createdAt: r.created_at,
})

export class LucidBusinessCalendarStore implements BusinessCalendarStore {
  async insert(scope: TenantScope, v: NewBusinessCalendar) {
    const rows = await query<BusinessRow>(
      scope,
      `insert into business_calendars (tenant_id, organization_id, name, timezone, weekly_working_hours, holidays,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
       on conflict (tenant_id, organization_id, name) do nothing returning ${BUS}`,
      [
        tenantOf(scope),
        v.organizationId,
        v.name,
        v.timezone,
        json(v.weeklyWorkingHours),
        json(v.holidays),
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return rows[0] ? toBusiness(rows[0]) : null
  }

  async find(scope: TenantScope, id: string) {
    const rows = await query<BusinessRow>(
      scope,
      `select ${BUS} from business_calendars where id = ?`,
      [id]
    )
    return rows[0] ? toBusiness(rows[0]) : null
  }

  async list(scope: TenantScope) {
    const rows = await query<BusinessRow>(
      scope,
      `select ${BUS} from business_calendars order by name, id`
    )
    return rows.map(toBusiness)
  }

  async update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewBusinessCalendar, 'organizationId'>
  ) {
    const rows = await query<BusinessRow>(
      scope,
      `update business_calendars set name = ?, timezone = ?, weekly_working_hours = ?::jsonb,
         holidays = ?::jsonb, version = version + 1, updated_at = now(), updated_by_membership_id = ?
       where id = ? and version = ? returning ${BUS}`,
      [
        v.name,
        v.timezone,
        json(v.weeklyWorkingHours),
        json(v.holidays),
        actorOf(scope),
        id,
        version,
      ]
    )
    return rows[0] ? toBusiness(rows[0]) : null
  }

  async remove(scope: TenantScope, id: string) {
    const rows = await query<{ id: string }>(
      scope,
      `delete from business_calendars where id = ? returning id`,
      [id]
    )
    return rows.length > 0
  }

  async organizationExists(scope: TenantScope, id: string) {
    const rows = await query(scope, `select 1 from organizations where id = ?`, [id])
    return rows.length > 0
  }
}
