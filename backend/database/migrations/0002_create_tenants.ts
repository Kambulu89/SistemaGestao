import { BaseSchema } from '@adonisjs/lucid/schema'
import { createGlobalTable } from '#database/support/tables'

/** Tenant: o cliente SaaS e a fronteira de isolamento (tabela global do plano de controlo). */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'tenants', (table) => {
      table.string('code', 30).notNullable().unique()
      table.string('name', 160).notNullable()
      table.string('slug', 60).notNullable().unique()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.specificType('country_code', 'char(2)').notNullable()
      table.specificType('default_currency', 'char(3)').notNullable()
      table.string('locale', 10).notNullable().defaultTo('pt-AO')
      table.string('timezone', 60).notNullable().defaultTo('Africa/Luanda')
      table.integer('version').notNullable().defaultTo(1)
      table.check(
        "status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED') AND code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$' AND slug ~ '^[a-z0-9][a-z0-9-]{1,59}$' AND country_code ~ '^[A-Z]{2}$' AND default_currency ~ '^[A-Z]{3}$'",
        [],
        'tenants_values_check'
      )
    })
  }

  async down() {
    this.schema.dropTable('tenants')
  }
}
