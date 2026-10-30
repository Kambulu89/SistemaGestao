import { ApiError } from '#core/http/api_error'
import type { Issue } from '#modules/notifications/domain/notifications'

export const notificationValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export const failure = (path: string, code: string, message: string) =>
  notificationValidation([{ path, code, message }])

export const MAX_PAGE = 200

export interface Clock {
  now(): Date
}
