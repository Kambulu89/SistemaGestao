import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

/**
 * Baseline: `app_current_tenant_id()` lê o tenant definido na transacção (`set_config('app.tenant_id', …, true)`); sem
 * contexto devolve NULL e as políticas RLS negam tudo. A conta de runtime recebe só DML nas tabelas criadas pela dona.
 */
export default class extends BaseSchema {
  async up() {
    const runtime = env.get('DB_USER')
    const owner = env.get('DB_OWNER_USER')
    this.schema.raw(`
      CREATE FUNCTION app_current_tenant_id() RETURNS uuid
      LANGUAGE sql STABLE PARALLEL SAFE
      AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$
    `)
    this.schema.raw(`GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO "${runtime}"`)
    this.schema.raw(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${runtime}"`
    )
    this.schema.raw(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${runtime}"`
    )
  }

  async down() {
    const runtime = env.get('DB_USER')
    const owner = env.get('DB_OWNER_USER')
    this.schema.raw(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM "${runtime}"`
    )
    this.schema.raw(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM "${runtime}"`
    )
    this.schema.raw(`DROP FUNCTION app_current_tenant_id()`)
  }
}
