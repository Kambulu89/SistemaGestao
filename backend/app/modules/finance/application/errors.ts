import { ApiError } from '#core/http/api_error'
import type { Issue } from '#modules/finance/domain/finance'

export const financeValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export const failure = (path: string, code: string, message: string) =>
  financeValidation([{ path, code, message }])

export const MAX_PAGE = 200
export const MAX_LINES = 100

export interface Clock {
  now(): Date
}

/** A data civil (UTC) de hoje, `AAAA-MM-DD`. */
export const todayOf = (clock: Clock): string => clock.now().toISOString().slice(0, 10)
