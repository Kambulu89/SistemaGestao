import { LucidOutboxWriter } from '#core/outbox/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { BookingUseCases, EventUseCases } from '#modules/calendar/application/event_use_cases'
import {
  BusinessCalendarUseCases,
  CalendarUseCases,
  ResourceUseCases,
} from '#modules/calendar/application/calendar_use_cases'
import {
  LucidBookingStore,
  LucidBusinessCalendarStore,
  LucidCalendarStore,
  LucidEventStore,
  LucidResourceStore,
} from '#modules/calendar/infrastructure/lucid_calendar'

function build() {
  const uow = new LucidTenantDatabase()
  const clock = { now: () => new Date() }
  const outbox = new LucidOutboxWriter()
  const resourceStore = new LucidResourceStore()
  const eventStore = new LucidEventStore()
  const bookingStore = new LucidBookingStore()

  const calendars = new CalendarUseCases(uow, new LucidCalendarStore(), resourceStore)
  const resources = new ResourceUseCases(uow, resourceStore)
  return {
    calendars,
    resources,
    events: new EventUseCases(uow, eventStore, bookingStore, calendars, outbox, clock),
    bookings: new BookingUseCases(
      uow,
      bookingStore,
      eventStore,
      calendars,
      resources,
      outbox,
      clock
    ),
    business: new BusinessCalendarUseCases(uow, new LucidBusinessCalendarStore(), clock),
  }
}

let instance: ReturnType<typeof build> | undefined

export const calendarServices = () => (instance ??= build())
