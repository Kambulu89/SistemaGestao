import { ApiError } from '#core/http/api_error'
import type { Issue } from '#modules/calendar/domain/calendar'

export const calendarValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export const failure = (path: string, code: string, message: string) =>
  calendarValidation([{ path, code, message }])

export const unavailable = (details: { path: string; message: string }[] = []) =>
  ApiError.conflict(
    'RESOURCE_UNAVAILABLE',
    'O recurso já está reservado nesse horário.',
    details.map((d) => ({ path: d.path, code: 'RESOURCE_UNAVAILABLE', message: d.message }))
  )
