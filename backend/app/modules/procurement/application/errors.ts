import { ApiError } from '#core/http/api_error'
import type { Issue } from '#modules/procurement/domain/procurement'

export const procurementValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export const failure = (path: string, code: string, message: string) =>
  procurementValidation([{ path, code, message }])

export const denied = () =>
  new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')

export const MAX_PAGE = 200
export const MAX_LINES = 100

export interface Clock {
  now(): Date
}
