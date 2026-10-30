import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig, targets } from '@adonisjs/core/logger'

/**
 * Caminhos de campos cujo valor nunca pode chegar aos logs. Complementa a regra de não registar
 * payloads: o que não é necessário para diagnosticar não se regista.
 */
export const REDACTED_PATHS = [
  'password',
  'passwordConfirmation',
  'token',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  '*.password',
  '*.passwordConfirmation',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'currentPassword',
  '*.currentPassword',
  'newPassword',
  '*.newPassword',
  'passwordHash',
  '*.passwordHash',
  'csrfToken',
  '*.csrfToken',
  'sessionToken',
  '*.sessionToken',
  'verificationToken',
  '*.verificationToken',
]

const loggerConfig = defineConfig({
  default: 'app',

  loggers: {
    app: {
      enabled: true,
      name: 'sistema-gestao-api',
      level: env.get('LOG_LEVEL'),
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      transport: {
        targets: targets()
          .pushIf(!app.inProduction, targets.pretty())
          .pushIf(app.inProduction, targets.file({ destination: 1 }))
          .toArray(),
      },
    },
  },
})

export default loggerConfig

declare module '@adonisjs/core/types' {
  export interface LoggersList extends InferLoggers<typeof loggerConfig> {}
}
