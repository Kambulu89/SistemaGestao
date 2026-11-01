import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { CORRELATION_HEADER, resolveCorrelationId } from '#core/http/correlation'

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /** Identificador que liga o pedido, os logs, os erros devolvidos e, futuramente, a auditoria e os eventos. */
    correlationId: string
  }
}

/**
 * Gera ou valida o correlation id, expõe-no na resposta e acrescenta-o ao logger do pedido, de modo
 * que todos os logs desse pedido o transportam.
 */
export default class CorrelationIdMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const correlationId = resolveCorrelationId(ctx.request.header(CORRELATION_HEADER))

    ctx.correlationId = correlationId
    ctx.logger = ctx.logger.child({ correlationId })
    ctx.response.header(CORRELATION_HEADER, correlationId)

    return next()
  }
}
