import env from '#start/env'
import { defineConfig } from '@adonisjs/cors'

const origins = env
  .get('CORS_ORIGINS')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

export default defineConfig({
  enabled: true,
  /** Lista explícita: nunca `*` com credenciais (sessões em cookie). */
  origin: origins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  headers: true,
  exposeHeaders: ['x-correlation-id', 'retry-after'],
  credentials: true,
  maxAge: 90,
})
