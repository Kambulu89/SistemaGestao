import { ApiError } from '#core/http/api_error'
import type { Issue } from '#modules/reporting/domain/reporting'

export const reportValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export const failure = (path: string, code: string, message: string) =>
  reportValidation([{ path, code, message }])

export const denied = () =>
  new ApiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')
