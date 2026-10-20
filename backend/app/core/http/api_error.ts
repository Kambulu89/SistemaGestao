/** Um detalhe de erro por campo/regra, com o caminho completo (ex.: `lines[0].quantity`). */
export interface ApiErrorDetail {
  path: string
  code: string
  message: string
}

/**
 * Erro de negócio ou de transporte com forma estável. É a única classe cujos `code` e `message`
 * chegam ao cliente tal como definidos; qualquer outro erro é tratado como interno e redigido.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = [],
    readonly headers: Record<string, string> = {}
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static notFound(message = 'Recurso não encontrado.') {
    return new ApiError(404, 'NOT_FOUND', message)
  }

  static conflict(code: string, message: string, details: ApiErrorDetail[] = []) {
    return new ApiError(409, code, message, details)
  }

  static notReady(details: ApiErrorDetail[]) {
    return new ApiError(503, 'NOT_READY', 'O serviço ainda não está pronto.', details)
  }
}
