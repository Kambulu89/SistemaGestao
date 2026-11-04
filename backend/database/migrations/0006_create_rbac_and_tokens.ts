import { BaseSchema } from '@adonisjs/lucid/schema'
import { createGlobalTable, createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * RBAC e tokens de uso único.
 *  - `permissions` (global): catálogo definido no código e sincronizado (`node ace rbac:sync`); igual para todos os tenants.
 *  - `roles`, `role_permissions`, `membership_roles` (tenant): perfis da empresa e atribuições com âmbito. Nesta fase o
 *    âmbito é `TENANT` (toda a empresa) ou `OWN` (só registos próprios); entidade legal, filial, departamento e equipa
 *    entram com a estrutura organizacional (bloco 3.4).
 *  - `one_time_tokens` (global): convites e recuperação de palavra-passe; só o hash do token é guardado.
 */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'permissions', (table) => {
      table.string('code', 80).notNullable().unique()
      table.string('module', 40).notNullable()
      table.string('description', 300).notNullable()
    })

    createTenantTable(this, 'roles', (table) => {
      table.string('code', 50).notNullable()
      table.string('name', 120).notNullable()
      table.string('description', 500).nullable()
      table.boolean('is_system').notNullable().defaultTo(false)
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'roles_code_unique' })
      table.check("status IN ('ACTIVE', 'INACTIVE')", [], 'roles_status_check')
    })

    createTenantTable(this, 'role_permissions', (table) => {
      table.uuid('role_id').notNullable()
      table
        .string('permission_code', 80)
        .notNullable()
        .references('code')
        .inTable('permissions')
        .onDelete('CASCADE')
      tenantForeignKey(table, 'role_id', 'roles', 'CASCADE')
      table.unique(['tenant_id', 'role_id', 'permission_code'], {
        indexName: 'role_permissions_unique',
      })
    })

    createTenantTable(this, 'membership_roles', (table) => {
      table.uuid('membership_id').notNullable()
      table.uuid('role_id').notNullable()
      table.string('scope_type', 20).notNullable().defaultTo('TENANT')
      tenantForeignKey(table, 'membership_id', 'tenant_memberships', 'CASCADE')
      tenantForeignKey(table, 'role_id', 'roles', 'RESTRICT')
      table.unique(['tenant_id', 'membership_id', 'role_id', 'scope_type'], {
        indexName: 'membership_roles_unique',
      })
      table.check("scope_type IN ('TENANT', 'OWN')", [], 'membership_roles_scope_check')
    })

    createGlobalTable(this, 'one_time_tokens', (table) => {
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('purpose', 20).notNullable()
      table.uuid('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE')
      table.uuid('membership_id').nullable()
      table.string('token_hash', 64).notNullable().unique()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('consumed_at', { useTz: true }).nullable()
      table.index(['user_id', 'purpose'], 'one_time_tokens_user_purpose_index')
      table.check(
        "purpose IN ('INVITATION', 'PASSWORD_RESET')",
        [],
        'one_time_tokens_purpose_check'
      )
    })

    this.schema.alterTable('tenant_memberships', (table) => {
      table.uuid('invited_by').nullable()
      table.timestamp('invited_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.alterTable('tenant_memberships', (table) => {
      table.dropColumn('invited_at')
      table.dropColumn('invited_by')
    })
    this.schema.dropTable('one_time_tokens')
    this.schema.dropTable('membership_roles')
    this.schema.dropTable('role_permissions')
    this.schema.dropTable('roles')
    this.schema.dropTable('permissions')
  }
}
