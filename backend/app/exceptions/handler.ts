import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import { errors as vineErrors } from '@vinejs/vine'
import { ApiError } from '#shared/http/api_error'

/**
 * Converte qualquer erro em `{ error: { code, message, details, requestId } }`. Erros inesperados são registados e
 * devolvidos como 500 genérico: a resposta nunca leva stack, SQL nem segredos.
 */
export default class HttpExceptionHandler extends ExceptionHandler {
  protected debug = false

  async handle(error: unknown, ctx: HttpContext) {
    const requestId = ctx.request.id()
    const send = (status: number, code: string, message: string, details: unknown[] = []) =>
      ctx.response.status(status).send({ error: { code, message, details, requestId } })

    if (error instanceof ApiError) {
      if (error.status === 429) {
        const retry = error.details.find((d) => d.code === 'RETRY_AFTER')?.message
        if (retry) ctx.response.header('retry-after', retry)
        return send(429, error.code, error.message)
      }
      return send(error.status, error.code, error.message, error.details)
    }
    if (error instanceof vineErrors.E_VALIDATION_ERROR) {
      const details = (error.messages as { field: string; rule: string; message: string }[]).map(
        (m) => ({
          path: m.field,
          code: m.rule.toUpperCase(),
          message: m.message,
        })
      )
      return send(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)
    }
    const status = (error as { status?: number }).status
    if (status === 404) return send(404, 'NOT_FOUND', 'Recurso inexistente.')
    if (status === 413) return send(413, 'PAYLOAD_TOO_LARGE', 'Pedido demasiado grande.')
    if (status === 400) return send(400, 'BAD_REQUEST', 'Pedido inválido.')
    return send(500, 'INTERNAL_ERROR', 'Erro interno. Indique o requestId ao suporte.')
  }

  async report(error: unknown, ctx: HttpContext) {
    if (error instanceof ApiError || error instanceof vineErrors.E_VALIDATION_ERROR) return
    if (app.inTest && (error as { status?: number }).status === 404) return
    return super.report(error, ctx)
  }
}
