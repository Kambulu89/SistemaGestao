import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Fecho (Prompt 06, bloco 6.10): tarefas manuais da checklist de cada período e o registo do encerramento de cada
 * exercício (apuramento de resultados e transporte de saldos), com o histórico de reaberturas. As verificações
 * automáticas da checklist são calculadas a pedido; os lançamentos do encerramento são lançamentos normais.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'close_tasks', (table) => {
      table.uuid('period_id').notNullable()
      table.string('title', 200).notNullable()
      table.boolean('done').notNullable().defaultTo(false)
      table.uuid('done_by').nullable()
      table.timestamp('done_at', { useTz: true }).nullable()
      table.string('note', 500).nullable()
      tenantForeignKey(table, 'period_id', 'fiscal_periods', 'CASCADE')
      table.unique(['tenant_id', 'period_id', 'title'], { indexName: 'close_tasks_title_unique' })
      table.check('(done = false) OR (done_at IS NOT NULL)', [], 'close_tasks_done_check')
    })

    createTenantTable(this, 'fiscal_year_closings', (table) => {
      table.uuid('fiscal_year_id').notNullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.uuid('result_account_id').notNullable()
      table.uuid('journal_id').notNullable()
      table.uuid('closing_entry_id').nullable()
      table.uuid('next_fiscal_year_id').nullable()
      table.uuid('opening_entry_id').nullable()
      table.specificType('net_result', 'numeric(24,6)').notNullable()
      table.jsonb('acknowledged').nullable()
      table.uuid('reopened_by').nullable()
      table.timestamp('reopened_at', { useTz: true }).nullable()
      table.string('reopen_reason', 500).nullable()
      tenantForeignKey(table, 'fiscal_year_id', 'fiscal_years')
      tenantForeignKey(table, 'result_account_id', 'accounts')
      tenantForeignKey(table, 'journal_id', 'journals')
      tenantForeignKey(table, 'closing_entry_id', 'journal_entries')
      tenantForeignKey(table, 'next_fiscal_year_id', 'fiscal_years')
      tenantForeignKey(table, 'opening_entry_id', 'journal_entries')
      table.check(`status IN ('ACTIVE','REVERSED')`, [], 'fiscal_year_closings_status_check')
      table.check(
        `(status = 'ACTIVE') = (reopened_at IS NULL)`,
        [],
        'fiscal_year_closings_reopen_check'
      )
    })
    // Um só encerramento em vigor por exercício; os anteriores (reabertos) ficam no histórico.
    this.schema.raw(
      `CREATE UNIQUE INDEX fiscal_year_closings_one_active ON fiscal_year_closings (tenant_id, fiscal_year_id)
        WHERE status = 'ACTIVE'`
    )
    // E um exercício seguinte só recebe o transporte de um encerramento em vigor.
    this.schema.raw(
      `CREATE UNIQUE INDEX fiscal_year_closings_one_carry ON fiscal_year_closings (tenant_id, next_fiscal_year_id)
        WHERE status = 'ACTIVE' AND next_fiscal_year_id IS NOT NULL`
    )
  }

  async down() {
    this.schema.dropTable('fiscal_year_closings')
    this.schema.dropTable('close_tasks')
  }
}
