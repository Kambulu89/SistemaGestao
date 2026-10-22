import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'
import { createTenantTable, dropTable } from '#database/support/tenant_tables'

/**
 * `TenantMembership` (C05): liga a identidade global (`users`) a cada tenant. É uma tabela **de tenant**
 * (RLS forçada). Para resolver o tenant de um pedido é preciso ler as memberships do próprio utilizador
 * *antes* de haver contexto de tenant; para isso existe uma segunda política, só de leitura, baseada em
 * `app.user_id` (definido pelo servidor a partir da sessão autenticada, nunca pelo cliente). Escritas
 * continuam a exigir o contexto de tenant (`WITH CHECK`).
 */
export default class extends BaseSchema {
  async up() {
    const runtime = env.get('DB_USER')

    this.schema.raw(`
      CREATE FUNCTION app_current_user_id() RETURNS uuid
      LANGUAGE sql STABLE PARALLEL SAFE
      AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$
    `)
    this.schema.raw(`GRANT EXECUTE ON FUNCTION app_current_user_id() TO "${runtime}"`)

    createTenantTable(this, 'tenant_memberships', (table) => {
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      // Sem FK por agora: `people` (C08) e `organizations` (C07) chegam em fatias posteriores.
      table.uuid('person_id').nullable()
      table.uuid('default_organization_id').nullable()
      table
        .enum('status', ['INVITED', 'ACTIVE', 'SUSPENDED', 'LEFT'], {
          useNative: false,
          enumName: 'tenant_memberships_status_check',
        })
        .notNullable()
        .defaultTo('INVITED')
      table.timestamp('joined_at', { useTz: true }).nullable()
      // Incrementa sempre que os acessos da membership mudam: invalida decisões e caches de autorização.
      table.integer('authorization_version').notNullable().defaultTo(1)
      table.unique(['tenant_id', 'user_id'], { indexName: 'tenant_memberships_tenant_user_unique' })
      table.index(['user_id'], 'tenant_memberships_user_id_index')
      table.check('authorization_version >= 1', [], 'tenant_memberships_authz_version_check')
    })

    this.schema.raw(`
      CREATE POLICY tenant_memberships_self_read ON tenant_memberships
        FOR SELECT USING (user_id = app_current_user_id())
    `)
  }

  async down() {
    dropTable(this, 'tenant_memberships')
    this.schema.raw(`DROP FUNCTION IF EXISTS app_current_user_id()`)
  }
}
