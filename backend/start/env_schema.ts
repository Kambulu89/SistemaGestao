import { Env } from '@adonisjs/core/env'

/**
 * Esquema das variáveis de ambiente. É validado no arranque (`start/env.ts`): uma variável em falta
 * ou inválida impede a aplicação de iniciar. Segredos usam `Env.schema.string()` para nunca
 * aparecerem em logs nem em `console.log`.
 */
export const envSchema = {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum([
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'silent',
  ] as const),
  APP_KEY: Env.schema.string(),

  /** Origens autorizadas pelo CORS, separadas por vírgulas. */
  CORS_ORIGINS: Env.schema.string(),

  /**
   * Base de dados. A aplicação corre com a conta `DB_USER` (sem superuser nem BYPASSRLS, para que a
   * RLS se aplique). As migrations correm com `DB_OWNER_USER`, que nunca é usada em tempo de execução.
   */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_DATABASE: Env.schema.string(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string(),
  DB_OWNER_USER: Env.schema.string(),
  DB_OWNER_PASSWORD: Env.schema.string(),

  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_PASSWORD: Env.schema.string.optional(),
} as const
