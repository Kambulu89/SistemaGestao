import { createHmac, timingSafeEqual } from 'node:crypto'
import env from '#start/env'

const key = () => env.get('APP_KEY').release()

/** HMAC com a APP_KEY: token CSRF derivado da sessão e chaves de rate limit sem dados pessoais em claro. */
export const hmac = (purpose: string, value: string) =>
  createHmac('sha256', key()).update(`${purpose}:${value}`).digest('hex')

export const csrfTokenFor = (sessionToken: string) => hmac('csrf', sessionToken)

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
