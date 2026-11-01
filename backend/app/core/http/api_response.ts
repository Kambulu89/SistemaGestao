import type { HttpContext } from '@adonisjs/core/http'

export interface ApiEnvelope<T> {
  data: T
  meta: { correlationId: string } & Record<string, unknown>
}

export interface ApiErrorEnvelope {
  error: {
    code: string
    message: string
    details: { path: string; code: string; message: string }[]
    correlationId: string
  }
}

/**
 * Envelope de sucesso: `{ data, meta: { correlationId } }`. Valores decimais atravessam a API como
 * strings; IDs são UUID em string (convenções em docs/architecture.md).
 */
export function envelope<T>(
  ctx: Pick<HttpContext, 'correlationId'>,
  data: T,
  meta: Record<string, unknown> = {}
): ApiEnvelope<T> {
  return { data, meta: { ...meta, correlationId: ctx.correlationId } }
}

/** Envelope de erro uniforme. Nunca inclui stack, SQL nem segredos. */
export function errorEnvelope(
  correlationId: string,
  code: string,
  message: string,
  details: { path: string; code: string; message: string }[] = []
): ApiErrorEnvelope {
  return { error: { code, message, details, correlationId } }
}
