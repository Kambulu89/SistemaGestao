import type { HttpContext } from '@adonisjs/core/http'

/** Resposta de sucesso uniforme: `{ data, meta: { requestId, ...extra } }`. */
export function ok<T>(ctx: HttpContext, data: T, meta: Record<string, unknown> = {}) {
  return { data, meta: { requestId: ctx.request.id(), ...meta } }
}

export function created<T>(ctx: HttpContext, data: T, location?: string) {
  ctx.response.status(201)
  if (location) ctx.response.header('location', location)
  return ok(ctx, data)
}
