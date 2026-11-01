import { ApiError } from '#core/http/api_error'
import type { Issue } from '#modules/prospecting/domain/prospecting'

export const prospectingValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export const failure = (path: string, code: string, message: string) =>
  prospectingValidation([{ path, code, message }])

export const MAX_PAGE = 200
export const MAX_MEMBERS_PER_CALL = 500

export interface Clock {
  now(): Date
}

export const todayOf = (clock: Clock): string => clock.now().toISOString().slice(0, 10)
