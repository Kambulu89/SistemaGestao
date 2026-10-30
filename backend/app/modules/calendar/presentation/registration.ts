import { registerNotificationRule, registerResourceLink } from '#modules/notifications/index'
import { calendarServices } from '#modules/calendar/presentation/composition'

let registered = false

const recipientsOf = (payload: Record<string, unknown>): string[] =>
  Array.isArray(payload['recipients'])
    ? payload['recipients'].filter((r): r is string => typeof r === 'string')
    : []

/**
 * Liga o calendário às notificações (S02), sem ele as conhecer: cancelar um evento ou uma reserva avisa quem participa
 * (menos quem cancelou), e a ligação das notificações abre o evento só a quem ainda o pode ver. Chamada no arranque.
 */
export function registerCalendar(): void {
  if (registered) return
  registered = true

  registerNotificationRule({
    code: 'calendar.event.cancelled',
    eventTypes: ['calendar.event.cancelled'],
    async build(_context, event) {
      const eventId = String(event.payload['eventId'] ?? '')
      const suffix = String(event.payload['occurrenceStart'] ?? event.payload['scope'] ?? 'ALL')
      return recipientsOf(event.payload).map((membershipId) => ({
        typeCode: 'calendar.event.cancelled',
        recipient: { membershipId },
        payload: {
          title: String(event.payload['title'] ?? ''),
          startsAt: String(event.payload['startsAt'] ?? ''),
        },
        dedupeSuffix: `${membershipId}:${suffix}`,
        resource: { type: 'calendar_event', id: eventId },
      }))
    },
  })

  registerNotificationRule({
    code: 'calendar.booking.cancelled',
    eventTypes: ['calendar.booking.cancelled'],
    async build(_context, event) {
      const eventId = String(event.payload['eventId'] ?? '')
      const bookingId = String(event.payload['bookingId'] ?? '')
      return recipientsOf(event.payload).map((membershipId) => ({
        typeCode: 'calendar.booking.cancelled',
        recipient: { membershipId },
        payload: {
          title: String(event.payload['title'] ?? ''),
          resourceName: String(event.payload['resourceName'] ?? ''),
          startsAt: String(event.payload['startsAt'] ?? ''),
        },
        dedupeSuffix: `${membershipId}:${bookingId}`,
        resource: { type: 'calendar_event', id: eventId },
      }))
    },
  })

  registerResourceLink('calendar_event', {
    permission: 'calendar.read',
    path: 'calendar/scheduling',
    async exists(context, id) {
      try {
        await calendarServices().events.get(context, id)
        return true
      } catch {
        return false
      }
    },
  })
}
