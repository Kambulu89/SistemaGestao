import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Clientes e relacionamento comercial (M01). O cliente **não duplica** a Party: guarda só as condições comerciais por
 * organização (prazo, crédito, gestor, segmento, estado). A mesma Party pode ser cliente de várias organizações do tenant
 * e (mais tarde) fornecedor. As interacções referenciam a Party, para manter o histórico mesmo sem venda. Nada se apaga.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'customer_segments', (table) => {
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('description', 500).nullable()
      table.boolean('active').notNullable().defaultTo(true)
      table.unique(['tenant_id', 'code'], { indexName: 'customer_segments_code_unique' })
    })

    createTenantTable(this, 'customers', (table) => {
      table.uuid('party_id').notNullable()
      table.uuid('organization_id').notNullable()
      table.string('code', 50).notNullable()
      table.uuid('segment_id').nullable()
      table.uuid('account_manager_membership_id').nullable()
      table.integer('payment_term_days').notNullable().defaultTo(0)
      table.decimal('credit_limit', 19, 4).notNullable().defaultTo(0)
      table.string('currency', 3).notNullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.string('status_reason', 300).nullable()
      tenantForeignKey(table, 'party_id', 'parties')
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'segment_id', 'customer_segments')
      tenantForeignKey(table, 'account_manager_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'code'], { indexName: 'customers_code_unique' })
      table.unique(['tenant_id', 'organization_id', 'party_id'], {
        indexName: 'customers_party_unique',
      })
      table.index(['tenant_id', 'status'], 'customers_status_index')
      table.index(['tenant_id', 'segment_id'], 'customers_segment_index')
    })
    this.schema.raw(`
      ALTER TABLE customers
        ADD CONSTRAINT customers_status_check CHECK (status IN ('ACTIVE', 'BLOCKED', 'INACTIVE')),
        ADD CONSTRAINT customers_terms_check CHECK (payment_term_days BETWEEN 0 AND 3650),
        ADD CONSTRAINT customers_credit_check CHECK (credit_limit >= 0),
        ADD CONSTRAINT customers_currency_check CHECK (currency ~ '^[A-Z]{3}$')
    `)

    createTenantTable(this, 'interactions', (table) => {
      table.uuid('party_id').notNullable()
      table.string('channel', 10).notNullable()
      table.string('subject', 200).notNullable()
      table.timestamp('occurred_at', { useTz: true }).notNullable()
      table.uuid('owner_membership_id').notNullable()
      table.text('summary').notNullable().defaultTo('')
      table.timestamp('follow_up_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'party_id', 'parties')
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'party_id', 'occurred_at'], 'interactions_party_index')
      table.index(['tenant_id', 'follow_up_at'], 'interactions_follow_up_index')
    })
    this.schema.raw(`
      ALTER TABLE interactions
        ADD CONSTRAINT interactions_channel_check CHECK (channel IN ('CALL', 'EMAIL', 'MEETING', 'NOTE')),
        ADD CONSTRAINT interactions_follow_up_check CHECK (follow_up_at IS NULL OR follow_up_at >= occurred_at)
    `)

    auditTable(this, 'customer_segments')
    auditTable(this, 'customers')
    auditTable(this, 'interactions')
  }

  async down() {
    dropTable(this, 'interactions')
    dropTable(this, 'customers')
    dropTable(this, 'customer_segments')
  }
}
