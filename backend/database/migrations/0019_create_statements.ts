import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Demonstrações financeiras (Prompt 06, bloco 6.8): modelos versionados por plano de contas (linhas, fórmulas e
 * mapeamento das contas por prefixo) e notas por exercício. Um modelo publicado não muda: uma alteração é uma nova
 * versão (rascunho), que ao ser publicada retira a anterior. As demonstrações são calculadas a pedido a partir do razão.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'statement_templates', (table) => {
      table.uuid('chart_id').notNullable()
      table.string('code', 30).notNullable()
      table.integer('template_version').notNullable().defaultTo(1)
      table.string('name', 160).notNullable()
      table.string('kind', 20).notNullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.string('check_a', 20).nullable()
      table.string('check_b', 20).nullable()
      table.timestamp('published_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'chart_id', 'account_charts')
      table.unique(['tenant_id', 'chart_id', 'code', 'template_version'], {
        indexName: 'statement_templates_version_unique',
      })
      table.check(
        `kind IN ('BALANCE_SHEET','INCOME_STATEMENT')`,
        [],
        'statement_templates_kind_check'
      )
      table.check(
        `status IN ('DRAFT','PUBLISHED','RETIRED')`,
        [],
        'statement_templates_status_check'
      )
    })
    // Uma só versão publicada por código e plano.
    this.schema.raw(
      `CREATE UNIQUE INDEX statement_templates_one_published ON statement_templates (tenant_id, chart_id, code)
        WHERE status = 'PUBLISHED'`
    )
    // E um só rascunho.
    this.schema.raw(
      `CREATE UNIQUE INDEX statement_templates_one_draft ON statement_templates (tenant_id, chart_id, code)
        WHERE status = 'DRAFT'`
    )

    createTenantTable(this, 'statement_template_lines', (table) => {
      table.uuid('template_id').notNullable()
      table.smallint('line_no').notNullable()
      table.string('code', 20).nullable()
      table.string('label', 200).notNullable()
      table.string('kind', 12).notNullable()
      table.smallint('sign').notNullable().defaultTo(1)
      table.string('formula', 500).nullable()
      table.string('note_ref', 20).nullable()
      tenantForeignKey(table, 'template_id', 'statement_templates', 'CASCADE')
      table.unique(['tenant_id', 'template_id', 'line_no'], {
        indexName: 'statement_template_lines_no_unique',
      })
      table.check(
        `kind IN ('HEADER','ACCOUNTS','TOTAL','NET_INCOME')`,
        [],
        'statement_template_lines_kind_check'
      )
      table.check('sign IN (1, -1)', [], 'statement_template_lines_sign_check')
    })
    createTenantTable(this, 'statement_template_mappings', (table) => {
      table.uuid('template_id').notNullable()
      table.string('line_code', 20).notNullable()
      table.string('account_prefix', 30).notNullable()
      table.string('balance_rule', 8).notNullable().defaultTo('ANY')
      tenantForeignKey(table, 'template_id', 'statement_templates', 'CASCADE')
      table.check(
        `balance_rule IN ('ANY','DEBIT','CREDIT')`,
        [],
        'statement_template_mappings_rule_check'
      )
    })

    createTenantTable(this, 'statement_notes', (table) => {
      table.uuid('fiscal_year_id').notNullable()
      table.integer('number').notNullable()
      table.string('title', 200).notNullable()
      table.text('body').notNullable()
      tenantForeignKey(table, 'fiscal_year_id', 'fiscal_years')
      table.unique(['tenant_id', 'fiscal_year_id', 'number'], {
        indexName: 'statement_notes_number_unique',
      })
      table.check('number BETWEEN 1 AND 999', [], 'statement_notes_number_check')
    })
  }

  async down() {
    this.schema.dropTable('statement_notes')
    this.schema.dropTable('statement_template_mappings')
    this.schema.dropTable('statement_template_lines')
    this.schema.dropTable('statement_templates')
  }
}
