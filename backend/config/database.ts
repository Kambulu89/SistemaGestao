import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

/**
 * Duas ligações, duas contas:
 *  - `runtime` (por omissão): conta da aplicação, sem superuser nem BYPASSRLS. É a única usada pelos
 *    pedidos, jobs e consumidores; por isso a RLS (Fase 1) aplica-se sempre.
 *  - `owner`: dona do esquema. Só para migrations e seeds (`npm run migrate`), nunca em runtime.
 */
const common = {
  client: 'pg' as const,
  debug: false,
  migrations: {
    naturalSort: true,
    paths: ['database/migrations'],
  },
}

const dbConfig = defineConfig({
  connection: 'runtime',
  connections: {
    runtime: {
      ...common,
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
      },
      pool: { min: 0, max: 10 },
    },
    owner: {
      ...common,
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_OWNER_USER'),
        password: env.get('DB_OWNER_PASSWORD'),
        database: env.get('DB_DATABASE'),
      },
      pool: { min: 0, max: 2 },
    },
  },
})

export default dbConfig
