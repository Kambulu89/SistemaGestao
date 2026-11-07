import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Notificações in-app (bloco 3.6): uma linha por destinatário (membership), com RLS por tenant. A leitura filtra sempre
 * pela membership em contexto: ninguém vê notificações de outro membro. O envio por email aguarda fornecedor (D-009).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'notifications', (table) => {
      table.uuid('recipient_membership_id').notNullable()
      table.string('type', 60).notNullable()
      table.string('title', 200).notNullable()
      table.text('body').nullable()
      table.string('subject_type', 60).nullable()
      table.uuid('subject_id').nullable()
      table.timestamp('read_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'recipient_membership_id', 'tenant_memberships', 'CASCADE')
      table.index(
        ['tenant_id', 'recipient_membership_id', 'created_at'],
        'notifications_recipient_index'
      )
    })
  }

  async down() {
    this.schema.dropTable('notifications')
  }
}
