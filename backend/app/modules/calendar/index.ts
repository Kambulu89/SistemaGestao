/** API pública do calendário, recursos e reservas (S03). Outros módulos importam **apenas** daqui. */
export { calendarServices } from '#modules/calendar/presentation/composition'
export { registerCalendar } from '#modules/calendar/presentation/registration'
export { expand, isValidZone, parseRule, workingMinutes } from '#modules/calendar/domain/calendar'
