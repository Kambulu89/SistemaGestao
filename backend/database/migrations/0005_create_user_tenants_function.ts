import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

/**
 * Antes de escolher um tenant, o utilizador precisa de saber a que empresas pertence; a RLS das memberships não deixa a
 * conta de runtime ler fora do tenant em contexto. Esta função (dona: `owner`, com BYPASSRLS) devolve **só** os vínculos
 * do utilizador indicado e só os campos necessários para o seletor de empresa. O backend chama-a apenas com o
 * utilizador autenticado.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      CREATE FUNCTION app_user_tenants(p_user_id uuid)
      RETURNS TABLE (membership_id uuid, tenant_id uuid, membership_status text)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
      AS $$
        SELECT m.id, m.tenant_id, m.status::text FROM tenant_memberships m WHERE m.user_id = p_user_id
      $$
    `)
    this.schema.raw(`REVOKE ALL ON FUNCTION app_user_tenants(uuid) FROM PUBLIC`)
    this.schema.raw(`GRANT EXECUTE ON FUNCTION app_user_tenants(uuid) TO "${env.get('DB_USER')}"`)
  }

  async down() {
    this.schema.raw(`DROP FUNCTION app_user_tenants(uuid)`)
  }
}
