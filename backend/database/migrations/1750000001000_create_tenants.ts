import { BaseSchema } from '@adonisjs/lucid/schema'
import { createGlobalTable, dropTable } from '#database/support/tenant_tables'

/**
 * Plano de controlo da plataforma (C01): `tenants` e `tenant_domains`. São tabelas **globais**
 * (enumeradas em `PLATFORM_TABLES`): não têm RLS porque descrevem os próprios tenants. Nenhuma tabela
 * de tenant aponta para elas além da FK de `tenant_id`.
 */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'tenants', (table) => {
      table.string('code', 50).notNullable().unique()
      table.string('name', 160).notNullable()
      table
        .enum('status', ['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'CLOSING', 'CLOSED'], {
          useNative: false,
          enumName: 'tenants_status_check',
        })
        .notNullable()
        .defaultTo('PROVISIONING')
      table.string('default_locale', 10).notNullable().defaultTo('pt-AO')
      table.string('timezone', 64).notNullable().defaultTo('Africa/Luanda')
      table.string('storage_region', 40).notNullable().defaultTo('default')
      table.text('provision_error').nullable()
      table.timestamp('activated_at', { useTz: true }).nullable()
    })
    this.schema.raw(
      `ALTER TABLE tenants ADD CONSTRAINT tenants_code_format CHECK (code ~ '^[a-z0-9_]+$')`
    )

    createGlobalTable(this, 'tenant_domains', (table) => {
      table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT')
      table.string('hostname', 253).notNullable().unique()
      table.string('verification_token_hash', 255).nullable()
      table.timestamp('verified_at', { useTz: true }).nullable()
      table.boolean('is_primary').notNullable().defaultTo(false)
      table.index(['tenant_id'], 'tenant_domains_tenant_id_index')
    })
    this.schema.raw(
      `ALTER TABLE tenant_domains ADD CONSTRAINT tenant_domains_hostname_lower CHECK (hostname = lower(hostname))`
    )
    // No máximo um domínio principal por tenant.
    this.schema.raw(
      `CREATE UNIQUE INDEX tenant_domains_one_primary ON tenant_domains (tenant_id) WHERE is_primary`
    )
  }

  async down() {
    dropTable(this, 'tenant_domains')
    dropTable(this, 'tenants')
  }
}
