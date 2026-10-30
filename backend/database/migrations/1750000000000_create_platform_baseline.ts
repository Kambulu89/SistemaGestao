import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

/**
 * Baseline da plataforma (sem tabelas de negócio).
 *  1. `app_current_tenant_id()`: lê o tenant do contexto SQL da transacção. É a base das políticas RLS
 *     da Fase 1; sem contexto devolve NULL e, por isso, nega o acesso.
 *  2. Privilégios por omissão da conta de runtime: só DML. A conta de runtime não é dona do esquema, não
 *     pode alterar estrutura e (ver docker/postgres/init/01-roles.sh) não é superuser nem tem BYPASSRLS.
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

    this.schema.raw(`GRANT USAGE ON SCHEMA public TO "${runtime}"`)
    this.schema.raw(`GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO "${runtime}"`)
    this.schema.raw(`
      ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${runtime}"
    `)
    this.schema.raw(`
      ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO "${runtime}"
    `)
  }

  async down() {
    const runtime = env.get('DB_USER')
    const owner = env.get('DB_OWNER_USER')

    this.schema.raw(`
      ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM "${runtime}"
    `)
    this.schema.raw(`
      ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM "${runtime}"
    `)
    this.schema.raw(`DROP FUNCTION IF EXISTS app_current_tenant_id()`)
  }
}
