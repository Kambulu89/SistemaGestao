import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const common = {
  client: 'pg' as const,
  debug: false,
  migrations: { naturalSort: true, paths: ['database/migrations'] },
}

const connection = (
  user: 'DB_USER' | 'DB_OWNER_USER',
  password: 'DB_PASSWORD' | 'DB_OWNER_PASSWORD'
) => ({
  host: env.get('DB_HOST'),
  port: env.get('DB_PORT'),
  user: env.get(user),
  password: env.get(password),
  database: env.get('DB_DATABASE'),
})

/**
 * Duas contas (ver `docs/architecture.md`):
 *  - `runtime` (por omissão): só DML; as tabelas de tenant têm RLS forçada, por isso sem `app.tenant_id` na transacção
 *    não vê nem escreve nada de nenhum tenant;
 *  - `owner`: dona do esquema, só para migrações (`npm run migrate`) e manutenção.
 * O registo de SQL está desligado: as consultas levam valores sensíveis (hashes, tokens).
 */
const dbConfig = defineConfig({
  connection: 'runtime',
  connections: {
    runtime: {
      ...common,
      connection: connection('DB_USER', 'DB_PASSWORD'),
      pool: { min: 0, max: 10 },
    },
    owner: {
      ...common,
      connection: connection('DB_OWNER_USER', 'DB_OWNER_PASSWORD'),
      pool: { min: 0, max: 2 },
    },
  },
})

export default dbConfig
