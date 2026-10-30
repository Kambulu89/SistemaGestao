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

  /** URL base do frontend, usada nas ligações enviadas por email (ex.: recuperação de palavra-passe). */
  WEB_BASE_URL: Env.schema.string({ format: 'url', tld: false }),
  /**
   * Entrega de tokens por email. `none`: sem entrega (o pedido continua a responder de forma genérica).
   * `dev-redis`: guarda a mensagem numa lista Redis para desenvolvimento/testes — **proibido em produção**.
   * Um fornecedor real só entra quando for escolhido (decisão de produto pendente).
   */
  MAIL_DRIVER: Env.schema.enum(['none', 'dev-redis'] as const),

  /**
   * Conectores HTTP de comunicação (S02), opcionais: um canal externo só entrega quando o seu URL está configurado. O
   * conector recebe um POST JSON `{ to, subject, body, dedupeKey }` com `Authorization: Bearer <token>` e
   * `Idempotency-Key`, e responde `{ id }`. `*_DEDUPE=true` declara que o fornecedor deduplica por essa chave.
   */
  NOTIFICATIONS_EMAIL_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  NOTIFICATIONS_EMAIL_TOKEN: Env.schema.string.optional(),
  NOTIFICATIONS_EMAIL_DEDUPE: Env.schema.boolean.optional(),
  NOTIFICATIONS_SMS_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  NOTIFICATIONS_SMS_TOKEN: Env.schema.string.optional(),
  NOTIFICATIONS_SMS_DEDUPE: Env.schema.boolean.optional(),
  NOTIFICATIONS_WHATSAPP_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  NOTIFICATIONS_WHATSAPP_TOKEN: Env.schema.string.optional(),
  NOTIFICATIONS_WHATSAPP_DEDUPE: Env.schema.boolean.optional(),

  /**
   * Documentos e anexos (S01). Os ficheiros ficam em disco local (`DOCUMENTS_STORAGE_DIR`, fora do repositório); o
   * armazenamento é uma porta, por isso um serviço de objectos pode substituí-lo. Limites por omissão: 25 MiB por ficheiro
   * e 1 GiB por tenant (a quota por plano é uma decisão de produto em aberto).
   */
  DOCUMENTS_STORAGE_DIR: Env.schema.string.optional(),
  DOCUMENTS_MAX_FILE_BYTES: Env.schema.number.optional(),
  DOCUMENTS_TENANT_QUOTA_BYTES: Env.schema.number.optional(),
  DOCUMENTS_UPLOAD_TTL_SECONDS: Env.schema.number.optional(),
  DOCUMENTS_DOWNLOAD_TTL_SECONDS: Env.schema.number.optional(),

  /** Só para o seeder de demonstração (nunca em produção). Sem valor por omissão. */
  DEMO_USER_PASSWORD: Env.schema.string.optional(),

  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_PASSWORD: Env.schema.string.optional(),
} as const

/** Regras entre variáveis que o esquema por campo não exprime. Lança se a combinação for insegura. */
export function assertEnvConsistency(values: {
  NODE_ENV: string
  MAIL_DRIVER: string
  APP_KEY: string
}) {
  if (values.NODE_ENV === 'production' && values.MAIL_DRIVER === 'dev-redis') {
    throw new Error('MAIL_DRIVER=dev-redis não é permitido em produção.')
  }
  if (values.APP_KEY.length < 32) {
    throw new Error('APP_KEY tem de ter pelo menos 32 caracteres.')
  }
}
