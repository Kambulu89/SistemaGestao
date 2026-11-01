import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/core/http'
import { Secret } from '@adonisjs/core/helpers'

/** `Secret` mascara o valor em `toString()`, `console.log` e JSON. */
export const appKey = new Secret(env.get('APP_KEY'))

export const http = defineConfig({
  /** Nunca gerar `x-request-id` a partir do cliente: o correlation id é tratado pelo middleware. */
  generateRequestId: true,
  allowMethodSpoofing: false,
  /** Permite aceder ao `HttpContext` em qualquer ponto do pedido (contexto de tenant, auditoria). */
  useAsyncLocalStorage: true,
  cookie: {
    domain: '',
    path: '/',
    maxAge: '2h',
    httpOnly: true,
    secure: app.inProduction,
    sameSite: 'lax',
  },
})
