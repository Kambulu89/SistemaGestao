export interface ErrorDetail {
  path: string
  code: string
  message: string
}

/**
 * Erro de aplicação com código estável. O gestor de excepções converte-o em
 * `{ error: { code, message, details, requestId } }`; nunca leva stack, SQL nem segredos.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetail[] = []
  ) {
    super(message)
  }

  static badRequest(code: string, message: string) {
    return new ApiError(400, code, message)
  }
  static unauthenticated() {
    return new ApiError(401, 'UNAUTHENTICATED', 'Sessão inexistente ou expirada.')
  }
  static forbidden(code = 'FORBIDDEN', message = 'Não tem permissão para esta operação.') {
    return new ApiError(403, code, message)
  }
  /** Inexistente ou fora do âmbito: nunca revela se existe noutro tenant. */
  static notFound() {
    return new ApiError(404, 'NOT_FOUND', 'Recurso inexistente.')
  }
  static conflict(code: string, message: string) {
    return new ApiError(409, code, message)
  }
  static versionConflict(current: number) {
    return new ApiError(409, 'VERSION_CONFLICT', 'O registo foi alterado entretanto; recarregue.', [
      { path: 'expectedVersion', code: 'STALE', message: `Versão actual: ${current}.` },
    ])
  }
  static validation(details: ErrorDetail[]) {
    return new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)
  }
  static tooManyRequests(retryAfterSeconds: number) {
    return new ApiError(429, 'TOO_MANY_REQUESTS', 'Demasiadas tentativas; tente mais tarde.', [
      { path: '', code: 'RETRY_AFTER', message: String(retryAfterSeconds) },
    ])
  }
}
