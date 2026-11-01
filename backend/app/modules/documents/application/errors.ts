import { ApiError } from '#core/http/api_error'
import type { Issue } from '#modules/documents/domain/documents'

export const documentValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export const failure = (path: string, code: string, message: string) =>
  documentValidation([{ path, code, message }])

export const MAX_PAGE = 100
