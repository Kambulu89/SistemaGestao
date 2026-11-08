import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Preferências do membro (interface): favoritos e disposição do painel, por membership (o mesmo utilizador noutra
 * empresa tem as suas). Valores JSON pequenos e validados por chave no serviço; não guardam dados de negócio.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'member_preferences', (table) => {
      table.uuid('membership_id').notNullable()
      table.string('key', 40).notNullable()
      table.jsonb('value').notNullable()
      tenantForeignKey(table, 'membership_id', 'tenant_memberships', 'CASCADE')
      table.unique(['tenant_id', 'membership_id', 'key'], {
        indexName: 'member_preferences_key_unique',
      })
    })
  }

  async down() {
    this.schema.dropTable('member_preferences')
  }
}
