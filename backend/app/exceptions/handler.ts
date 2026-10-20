import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http'
import { errors as vineErrors } from '@vinejs/vine'
import { errors as coreErrors } from '@adonisjs/core'
import { ApiError } from '#core/http/api_error'
import { errorEnvelope } from '#core/http/api_response'
import { resolveCorrelationId } from '#core/http/correlation'

/**
 * Converte qualquer erro no formato uniforme `{ error: { code, message, details, correlationId } }`.
 * Erros desconhecidos viram 500 genérico: o detalhe fica só nos logs (com o mesmo correlation id).
 */
export default class HttpExceptionHandler extends ExceptionHandler {
  /** Nunca devolver stack traces, mesmo em desenvolvimento: a API não tem modo "debug" para o cliente. */
  protected debug = false
  protected renderStatusPages = false

  async handle(error: unknown, ctx: HttpContext) {
    const correlationId = ctx.correlationId ?? resolveCorrelationId(undefined)
    const { status, body, headers } = this.toResponse(error, correlationId)

    for (const [name, value] of Object.entries(headers)) ctx.response.header(name, value)
    ctx.response.header('x-correlation-id', correlationId)
    return ctx.response.status(status).send(body)
  }

  async report(error: unknown, ctx: HttpContext) {
    // Só se registam as falhas do servidor (5xx e desconhecidas); erros do cliente são esperados.
    if (this.toResponse(error, ctx.correlationId ?? '').status < 500) return

    // Falhas previstas do domínio (ex.: dependência indisponível na prontidão) não precisam de stack.
    if (error instanceof ApiError) {
      ctx.logger.warn({ code: error.code, status: error.status }, error.message)
      return
    }
    return super.report(error, ctx)
  }

  private toResponse(error: unknown, correlationId: string) {
    if (error instanceof ApiError) {
      return {
        status: error.status,
        headers: error.headers,
        body: errorEnvelope(correlationId, error.code, error.message, error.details),
      }
    }

    if (error instanceof vineErrors.E_VALIDATION_ERROR) {
      const details = error.messages.map((m: { field: string; rule: string; message: string }) => ({
        path: m.field,
        code: m.rule.toUpperCase(),
        message: m.message,
      }))
      return {
        status: 422,
        headers: {},
        body: errorEnvelope(
          correlationId,
          'VALIDATION_ERROR',
          'Verifique os campos indicados.',
          details
        ),
      }
    }

    if (error instanceof coreErrors.E_ROUTE_NOT_FOUND) {
      return {
        status: 404,
        headers: {},
        body: errorEnvelope(correlationId, 'NOT_FOUND', 'Recurso não encontrado.'),
      }
    }

    const known = this.knownHttpError(error)
    if (known) {
      return {
        status: known.status,
        headers: {},
        body: errorEnvelope(correlationId, known.code, known.message),
      }
    }

    return {
      status: 500,
      headers: {},
      body: errorEnvelope(
        correlationId,
        'INTERNAL_ERROR',
        'Ocorreu um erro interno. Indique o código de correlação ao suporte.'
      ),
    }
  }

  /** Erros do framework com código estável (autenticação, autorização, limites, corpo inválido). */
  private knownHttpError(error: unknown): { status: number; code: string; message: string } | null {
    const code = (error as { code?: string } | null)?.code
    switch (code) {
      case 'E_UNAUTHORIZED_ACCESS':
        return { status: 401, code: 'UNAUTHENTICATED', message: 'Sessão inválida ou expirada.' }
      case 'E_AUTHORIZATION_FAILURE':
        return { status: 403, code: 'FORBIDDEN', message: 'Não tem permissão para esta operação.' }
      case 'E_TOO_MANY_REQUESTS':
        return {
          status: 429,
          code: 'RATE_LIMITED',
          message: 'Demasiados pedidos. Tente mais tarde.',
        }
      case 'E_REQUEST_ENTITY_TOO_LARGE':
        return {
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'O pedido excede o tamanho permitido.',
        }
      case 'E_MALFORMED_JSON': // sic: corpo JSON inválido
      case 'E_BAD_REQUEST':
        return { status: 400, code: 'BAD_REQUEST', message: 'Pedido malformado.' }
      default:
        return null
    }
  }
}
