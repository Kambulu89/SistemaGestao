import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Motor de contabilização (Prompt 06, bloco 6.3):
 *  - regras por entidade legal, origem e evento, com vigência (sem sobreposição de regras activas) e diário;
 *  - linhas da regra: lado, conta configurada pela empresa (nunca códigos fixos no código) e chave do montante do evento;
 *  - registo dos eventos recebidos (idempotente pela chave), com o lançamento gerado ou a mensagem de erro.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'posting_rules', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('source', 30).notNullable()
      table.string('event', 40).notNullable()
      table.uuid('journal_id').notNullable()
      table.boolean('auto_post').notNullable().defaultTo(false)
      table.string('description_template', 300).nullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'journal_id', 'journals')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], {
        indexName: 'posting_rules_code_unique',
      })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'posting_rules_status_check')
      table.check('valid_to IS NULL OR valid_to >= valid_from', [], 'posting_rules_validity_check')
    })
    // Para a mesma entidade, origem e evento, só uma regra activa em cada data.
    this.schema.raw(`ALTER TABLE posting_rules ADD CONSTRAINT posting_rules_no_overlap
      EXCLUDE USING gist (tenant_id WITH =, legal_entity_id WITH =, source WITH =, event WITH =,
        daterange(valid_from, valid_to, '[]') WITH &&) WHERE (status = 'ACTIVE')`)

    createTenantTable(this, 'posting_rule_lines', (table) => {
      table.uuid('rule_id').notNullable()
      table.smallint('line_no').notNullable()
      table.string('side', 6).notNullable()
      table.uuid('account_id').notNullable()
      table.string('amount_key', 40).notNullable()
      table.string('description', 300).nullable()
      table.uuid('cost_center_id').nullable()
      table.boolean('use_event_cost_center').notNullable().defaultTo(false)
      table.boolean('use_event_third_party').notNullable().defaultTo(false)
      tenantForeignKey(table, 'rule_id', 'posting_rules', 'CASCADE')
      tenantForeignKey(table, 'account_id', 'accounts')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.unique(['tenant_id', 'rule_id', 'line_no'], {
        indexName: 'posting_rule_lines_no_unique',
      })
      table.check(`side IN ('DEBIT','CREDIT')`, [], 'posting_rule_lines_side_check')
    })

    createTenantTable(this, 'posting_events', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('rule_id').nullable()
      table.string('source', 30).notNullable()
      table.string('event', 40).notNullable()
      table.string('source_ref', 120).notNullable()
      table.string('idempotency_key', 120).notNullable()
      table.date('occurred_on').notNullable()
      table.string('status', 10).notNullable()
      table.uuid('entry_id').nullable()
      table.jsonb('payload').notNullable()
      table.jsonb('error').nullable()
      table.integer('attempts').notNullable().defaultTo(1)
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'rule_id', 'posting_rules')
      tenantForeignKey(table, 'entry_id', 'journal_entries')
      table.unique(['tenant_id', 'idempotency_key'], { indexName: 'posting_events_key_unique' })
      table.index(['tenant_id', 'status'], 'posting_events_status_index')
      table.check(`status IN ('POSTED','DRAFTED','FAILED')`, [], 'posting_events_status_check')
    })
  }

  async down() {
    this.schema.dropTable('posting_events')
    this.schema.dropTable('posting_rule_lines')
    this.schema.dropTable('posting_rules')
  }
}
