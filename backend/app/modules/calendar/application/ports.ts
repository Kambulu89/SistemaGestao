import type { TenantScope } from '#core/tenancy/index'
import type {
  BookingStatus,
  CalendarVisibility,
  EventStatus,
  Holiday,
  ParticipantResponse,
  ResourceType,
  WorkingHours,
} from '#modules/calendar/domain/calendar'

export interface Clock {
  now(): Date
}

/** Quem consulta: decide o que os calendários com visibilidade PRIVATE/UNIT deixam ver. */
export interface Viewer {
  membershipId: string
  allUnits: boolean
  unitIds: readonly string[]
}

// --- calendários -------------------------------------------------------------------------------------

export interface CalendarRecord {
  id: string
  name: string
  ownerMembershipId: string | null
  unitId: string | null
  timezone: string
  visibility: CalendarVisibility
  version: number
  createdAt: Date
}

export interface NewCalendar {
  name: string
  ownerMembershipId: string | null
  unitId: string | null
  timezone: string
  visibility: CalendarVisibility
}

export interface CalendarStore {
  insert(scope: TenantScope, v: NewCalendar): Promise<CalendarRecord>
  find(scope: TenantScope, id: string): Promise<CalendarRecord | null>
  lock(scope: TenantScope, id: string): Promise<CalendarRecord | null>
  list(scope: TenantScope): Promise<CalendarRecord[]>
  update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewCalendar, 'ownerMembershipId'>
  ): Promise<CalendarRecord | null>
  remove(scope: TenantScope, id: string): Promise<boolean>
  hasEvents(scope: TenantScope, id: string): Promise<boolean>
}

// --- recursos ----------------------------------------------------------------------------------------

export interface ResourceRecord {
  id: string
  organizationId: string
  unitId: string | null
  code: string
  name: string
  type: ResourceType
  capacity: number
  active: boolean
  version: number
  createdAt: Date
}

export interface NewResource {
  organizationId: string
  unitId: string | null
  code: string
  name: string
  type: ResourceType
  capacity: number
  active: boolean
}

export interface ResourceStore {
  insert(scope: TenantScope, v: NewResource): Promise<ResourceRecord | null>
  find(scope: TenantScope, id: string): Promise<ResourceRecord | null>
  lock(scope: TenantScope, id: string): Promise<ResourceRecord | null>
  list(scope: TenantScope): Promise<ResourceRecord[]>
  update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewResource, 'organizationId' | 'code'>
  ): Promise<ResourceRecord | null>
  remove(scope: TenantScope, id: string): Promise<boolean>
  organizationExists(scope: TenantScope, id: string): Promise<boolean>
  unitExists(scope: TenantScope, id: string): Promise<boolean>
}

// --- eventos -----------------------------------------------------------------------------------------

export interface EventRecord {
  id: string
  calendarId: string
  title: string
  description: string | null
  startsAt: Date
  endsAt: Date
  timezone: string
  allDay: boolean
  recurrenceRule: string | null
  status: EventStatus
  sourceType: string | null
  sourceId: string | null
  createdByMembershipId: string | null
  version: number
  createdAt: Date
}

export interface NewEvent {
  calendarId: string
  title: string
  description: string | null
  startsAt: Date
  endsAt: Date
  timezone: string
  allDay: boolean
  recurrenceRule: string | null
  status: EventStatus
  sourceType: string | null
  sourceId: string | null
}

export interface ExceptionRecord {
  id: string
  eventId: string
  occurrenceStart: Date
  kind: 'CANCELLED' | 'MODIFIED'
  title: string | null
  startsAt: Date | null
  endsAt: Date | null
}

export interface ParticipantRecord {
  id: string
  eventId: string
  membershipId: string | null
  partyId: string | null
  response: ParticipantResponse
}

export interface EventStore {
  insert(scope: TenantScope, v: NewEvent): Promise<EventRecord>
  find(scope: TenantScope, id: string): Promise<EventRecord | null>
  lock(scope: TenantScope, id: string): Promise<EventRecord | null>
  findBySource(scope: TenantScope, type: string, id: string): Promise<EventRecord | null>
  /** Eventos visíveis a `viewer` que podem ter ocorrências em `[from, to)` (séries incluídas). */
  candidates(
    scope: TenantScope,
    viewer: Viewer,
    from: Date,
    to: Date,
    calendarId: string | null
  ): Promise<EventRecord[]>
  update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Partial<Omit<NewEvent, 'calendarId' | 'sourceType' | 'sourceId'>>
  ): Promise<EventRecord | null>
  setRule(scope: TenantScope, id: string, rule: string | null): Promise<void>
  cancel(scope: TenantScope, id: string): Promise<void>

  exceptions(scope: TenantScope, eventIds: string[]): Promise<ExceptionRecord[]>
  upsertException(scope: TenantScope, v: Omit<ExceptionRecord, 'id'>): Promise<ExceptionRecord>
  moveExceptions(scope: TenantScope, from: string, to: string, atOrAfter: Date): Promise<number>

  participants(scope: TenantScope, eventId: string): Promise<ParticipantRecord[]>
  addParticipant(
    scope: TenantScope,
    v: { eventId: string; membershipId: string | null; partyId: string | null }
  ): Promise<ParticipantRecord | null>
  copyParticipants(scope: TenantScope, from: string, to: string): Promise<void>
  removeParticipant(scope: TenantScope, eventId: string, id: string): Promise<boolean>
  respond(
    scope: TenantScope,
    eventId: string,
    membershipId: string,
    response: ParticipantResponse
  ): Promise<ParticipantRecord | null>
  membershipExists(scope: TenantScope, id: string): Promise<boolean>
  partyExists(scope: TenantScope, id: string): Promise<boolean>
}

// --- reservas ----------------------------------------------------------------------------------------

export interface BookingRecord {
  id: string
  eventId: string
  resourceId: string
  occurrenceStart: Date | null
  startsAt: Date
  endsAt: Date
  status: BookingStatus
  expiresAt: Date | null
  cancelReason: string | null
  version: number
  createdAt: Date
}

export interface NewBooking {
  eventId: string
  resourceId: string
  occurrenceStart: Date | null
  startsAt: Date
  endsAt: Date
  status: 'HELD' | 'CONFIRMED'
  expiresAt: Date | null
}

export interface BookingListItem extends BookingRecord {
  /** Só vem se o evento está num calendário que quem consulta pode ver. */
  eventTitle: string | null
}

/** Erro de colisão tal como o PostgreSQL a reporta (restrição de exclusão). */
export class BookingCollision extends Error {}

export interface BookingStore {
  find(scope: TenantScope, id: string): Promise<BookingRecord | null>
  lock(scope: TenantScope, id: string): Promise<BookingRecord | null>
  /** Passa a CANCELLED/EXPIRED as reservas provisórias vencidas do recurso (libertam o horário). */
  expireHolds(scope: TenantScope, resourceId: string, now: Date): Promise<number>
  /** Reservas activas do recurso que colidem com `[startsAt, endsAt)`. */
  conflicts(
    scope: TenantScope,
    resourceId: string,
    startsAt: Date,
    endsAt: Date
  ): Promise<{ startsAt: Date; endsAt: Date }[]>
  /** Lança `BookingCollision` se a restrição de exclusão recusar. */
  insert(scope: TenantScope, v: NewBooking): Promise<BookingRecord | null>
  confirm(scope: TenantScope, id: string): Promise<BookingRecord>
  cancel(scope: TenantScope, id: string, reason: string): Promise<BookingRecord>
  move(scope: TenantScope, id: string, startsAt: Date, endsAt: Date): Promise<void>
  repoint(scope: TenantScope, from: string, to: string, atOrAfter: Date): Promise<number>
  activeOfEvent(scope: TenantScope, eventId: string, now: Date): Promise<BookingRecord[]>
  /** Cancela as reservas activas (de uma ocorrência, desta em diante, ou todas) e devolve-as. */
  cancelFor(
    scope: TenantScope,
    eventId: string,
    filter: { occurrenceStart?: Date; atOrAfter?: Date },
    reason: string
  ): Promise<BookingRecord[]>
  existing(
    scope: TenantScope,
    eventId: string,
    resourceId: string
  ): Promise<{ occurrenceStart: Date | null }[]>
  list(
    scope: TenantScope,
    viewer: Viewer,
    filter: { resourceId: string | null; eventId: string | null; from: Date; to: Date },
    now: Date
  ): Promise<BookingListItem[]>
  busy(
    scope: TenantScope,
    viewer: Viewer,
    resourceId: string,
    from: Date,
    to: Date,
    now: Date
  ): Promise<{ id: string; startsAt: Date; endsAt: Date; status: BookingStatus; mine: boolean }[]>
  smallestCapacity(scope: TenantScope, eventId: string, now: Date): Promise<number | null>
}

// --- horário útil ------------------------------------------------------------------------------------

export interface BusinessCalendarRecord {
  id: string
  organizationId: string
  name: string
  timezone: string
  weeklyWorkingHours: WorkingHours
  holidays: Holiday[]
  version: number
  createdAt: Date
}

export interface NewBusinessCalendar {
  organizationId: string
  name: string
  timezone: string
  weeklyWorkingHours: WorkingHours
  holidays: Holiday[]
}

export interface BusinessCalendarStore {
  insert(scope: TenantScope, v: NewBusinessCalendar): Promise<BusinessCalendarRecord | null>
  find(scope: TenantScope, id: string): Promise<BusinessCalendarRecord | null>
  list(scope: TenantScope): Promise<BusinessCalendarRecord[]>
  update(
    scope: TenantScope,
    id: string,
    version: number,
    v: Omit<NewBusinessCalendar, 'organizationId'>
  ): Promise<BusinessCalendarRecord | null>
  remove(scope: TenantScope, id: string): Promise<boolean>
  organizationExists(scope: TenantScope, id: string): Promise<boolean>
}
