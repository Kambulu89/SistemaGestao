import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable } from '#database/support/tables'

/** Vínculo de um utilizador global a um tenant (um por par); só uma membership activa dá acesso ao tenant. */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'tenant_memberships', (table) => {
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.timestamp('joined_at', { useTz: true }).nullable()
      table.unique(['tenant_id', 'user_id'], { indexName: 'tenant_memberships_user_unique' })
      table.index(['user_id'], 'tenant_memberships_user_index')
      table.check(
        "status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED')",
        [],
        'tenant_memberships_status_check'
      )
    })
  }

  async down() {
    this.schema.dropTable('tenant_memberships')
  }
}
