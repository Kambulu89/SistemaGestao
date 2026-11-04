import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { ABSOLUTE_DAYS } from '#modules/identity/infrastructure/session_repository'
import { csrfTokenFor } from '#modules/identity/infrastructure/secrets'

/** Em produção o prefixo `__Host-` obriga a Secure, Path=/ e sem Domain. */
export const SESSION_COOKIE = app.inProduction ? '__Host-sg_session' : 'sg_session'
/** Lido pelo Angular (`HttpClient` envia-o em `X-XSRF-TOKEN` nos pedidos que alteram dados). */
export const XSRF_COOKIE = 'XSRF-TOKEN'
export const XSRF_HEADER = 'x-xsrf-token'

const base = { path: '/', sameSite: 'lax' as const, secure: app.inProduction, encode: false }

export function setSessionCookies(ctx: HttpContext, sessionToken: string) {
  const maxAge = `${ABSOLUTE_DAYS}d`
  ctx.response.plainCookie(SESSION_COOKIE, sessionToken, { ...base, httpOnly: true, maxAge })
  ctx.response.plainCookie(XSRF_COOKIE, csrfTokenFor(sessionToken), {
    ...base,
    httpOnly: false,
    maxAge,
  })
}

export function clearSessionCookies(ctx: HttpContext) {
  ctx.response.clearCookie(SESSION_COOKIE, { path: '/' })
  ctx.response.clearCookie(XSRF_COOKIE, { path: '/' })
}

export const readSessionToken = (ctx: HttpContext): string | undefined =>
  ctx.request.plainCookie(SESSION_COOKIE, { encoded: false }) || undefined
