import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Regularizações (Prompt 06, bloco 6.7): planos de recorrência, acréscimos e diferimentos; provisões e seus
 * movimentos; actualizações cambiais; reconciliação de contas. Tudo o que mexe no razão é um lançamento normal (em
 * rascunho, segue a aprovação); estas tabelas só o referenciam. Apagar o rascunho liberta a ocorrência (CASCADE).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'adjustment_schedules', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('kind', 12).notNullable()
      table.string('frequency', 12).notNullable().defaultTo('MONTHLY')
      table.uuid('journal_id').notNullable()
      table.date('start_month').notNullable()
      table.date('end_month').nullable()
      table.integer('months').nullable()
      table.specificType('total_amount', 'numeric(20,6)').nullable()
      table.uuid('debit_account_id').nullable()
      table.uuid('credit_account_id').nullable()
      table.uuid('cost_center_id').nullable()
      table.string('description', 300).nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'journal_id', 'journals')
      tenantForeignKey(table, 'debit_account_id', 'accounts')
      tenantForeignKey(table, 'credit_account_id', 'accounts')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], {
        indexName: 'adjustment_schedules_code_unique',
      })
      table.check(
        `kind IN ('RECURRING','ACCRUAL','DEFERRAL')`,
        [],
        'adjustment_schedules_kind_check'
      )
      table.check(
        `frequency IN ('MONTHLY','QUARTERLY','ANNUAL')`,
        [],
        'adjustment_schedules_frequency_check'
      )
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'adjustment_schedules_status_check')
      table.check(
        `extract(day from start_month) = 1 AND (end_month IS NULL OR (extract(day from end_month) = 1 AND end_month >= start_month))`,
        [],
        'adjustment_schedules_months_check'
      )
      // Acréscimo/diferimento: total, meses e as duas contas; recorrência: linhas próprias.
      table.check(
        `kind = 'RECURRING' OR (months BETWEEN 1 AND 600 AND total_amount > 0 AND debit_account_id IS NOT NULL AND credit_account_id IS NOT NULL)`,
        [],
        'adjustment_schedules_spread_check'
      )
    })
    createTenantTable(this, 'adjustment_schedule_lines', (table) => {
      table.uuid('schedule_id').notNullable()
      table.smallint('line_no').notNullable()
      table.uuid('account_id').notNullable()
      table.specificType('debit', 'numeric(20,6)').notNullable().defaultTo(0)
      table.specificType('credit', 'numeric(20,6)').notNullable().defaultTo(0)
      table.uuid('cost_center_id').nullable()
      table.string('third_party_ref', 60).nullable()
      table.string('description', 300).nullable()
      tenantForeignKey(table, 'schedule_id', 'adjustment_schedules', 'CASCADE')
      tenantForeignKey(table, 'account_id', 'accounts')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.unique(['tenant_id', 'schedule_id', 'line_no'], {
        indexName: 'adjustment_schedule_lines_no_unique',
      })
      table.check(
        '(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)',
        [],
        'adjustment_schedule_lines_side_check'
      )
    })
    createTenantTable(this, 'adjustment_occurrences', (table) => {
      table.uuid('schedule_id').notNullable()
      table.date('month').notNullable()
      table.specificType('amount', 'numeric(20,6)').notNullable()
      table.uuid('entry_id').notNullable()
      tenantForeignKey(table, 'schedule_id', 'adjustment_schedules')
      tenantForeignKey(table, 'entry_id', 'journal_entries', 'CASCADE')
      // Bloqueio de duplicados: um mês por plano.
      table.unique(['tenant_id', 'schedule_id', 'month'], {
        indexName: 'adjustment_occurrences_month_unique',
      })
    })

    createTenantTable(this, 'provisions', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('description', 300).nullable()
      table.uuid('journal_id').notNullable()
      table.uuid('expense_account_id').notNullable()
      table.uuid('provision_account_id').notNullable()
      table.uuid('reversal_account_id').notNullable()
      table.uuid('cost_center_id').nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'journal_id', 'journals')
      for (const c of ['expense_account_id', 'provision_account_id', 'reversal_account_id'])
        tenantForeignKey(table, c, 'accounts')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], {
        indexName: 'provisions_code_unique',
      })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'provisions_status_check')
    })
    createTenantTable(this, 'provision_movements', (table) => {
      table.uuid('provision_id').notNullable()
      table.string('type', 16).notNullable()
      table.date('movement_date').notNullable()
      table.specificType('amount', 'numeric(20,6)').notNullable()
      table.uuid('counter_account_id').nullable()
      table.string('reason', 300).notNullable()
      table.uuid('entry_id').notNullable()
      tenantForeignKey(table, 'provision_id', 'provisions')
      tenantForeignKey(table, 'counter_account_id', 'accounts')
      tenantForeignKey(table, 'entry_id', 'journal_entries', 'CASCADE')
      table.check(`type IN ('CONSTITUTION','REVERSAL','USE')`, [], 'provision_movements_type_check')
      table.check('amount > 0', [], 'provision_movements_amount_check')
      table.check(
        `(type = 'USE') = (counter_account_id IS NOT NULL)`,
        [],
        'provision_movements_counter_check'
      )
    })

    createTenantTable(this, 'fx_revaluations', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.date('revaluation_date').notNullable()
      table.uuid('entry_id').notNullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'entry_id', 'journal_entries', 'CASCADE')
      table.unique(['tenant_id', 'legal_entity_id', 'revaluation_date'], {
        indexName: 'fx_revaluations_date_unique',
      })
    })
    createTenantTable(this, 'fx_revaluation_lines', (table) => {
      table.uuid('revaluation_id').notNullable()
      table.string('kind', 12).notNullable()
      table.uuid('account_id').notNullable()
      table.string('currency', 3).notNullable()
      table.string('third_party_ref', 60).nullable()
      table.specificType('foreign_balance', 'numeric(24,6)').notNullable()
      table.specificType('functional_before', 'numeric(24,6)').notNullable()
      table.specificType('rate', 'numeric(20,10)').nullable()
      table.specificType('functional_after', 'numeric(24,6)').notNullable()
      table.specificType('difference', 'numeric(24,6)').notNullable()
      tenantForeignKey(table, 'revaluation_id', 'fx_revaluations', 'CASCADE')
      tenantForeignKey(table, 'account_id', 'accounts')
      table.check(`kind IN ('UNREALIZED','REALIZED')`, [], 'fx_revaluation_lines_kind_check')
      table.check('difference <> 0', [], 'fx_revaluation_lines_difference_check')
    })
    this.schema.raw(
      'CREATE INDEX fx_revaluation_lines_account_index ON fx_revaluation_lines (tenant_id, account_id, currency)'
    )

    createTenantTable(this, 'account_reconciliations', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('account_id').notNullable()
      table.string('third_party_ref', 60).nullable()
      table.specificType('total', 'numeric(24,6)').notNullable()
      table.string('note', 300).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'account_id', 'accounts')
    })
    createTenantTable(this, 'account_reconciliation_lines', (table) => {
      table.uuid('reconciliation_id').notNullable()
      table.uuid('entry_id').notNullable()
      table.smallint('line_no').notNullable()
      tenantForeignKey(table, 'reconciliation_id', 'account_reconciliations', 'CASCADE')
      // Bloqueio de duplicados: uma linha do razão só entra numa reconciliação.
      table.unique(['tenant_id', 'entry_id', 'line_no'], {
        indexName: 'account_reconciliation_lines_unique',
      })
    })
    this.schema.raw(`ALTER TABLE account_reconciliation_lines ADD CONSTRAINT reconciled_line_fk
      FOREIGN KEY (tenant_id, entry_id, line_no) REFERENCES journal_lines (tenant_id, entry_id, line_no) ON DELETE RESTRICT`)
  }

  async down() {
    for (const t of [
      'account_reconciliation_lines',
      'account_reconciliations',
      'fx_revaluation_lines',
      'fx_revaluations',
      'provision_movements',
      'provisions',
      'adjustment_occurrences',
      'adjustment_schedule_lines',
      'adjustment_schedules',
    ])
      this.schema.dropTable(t)
  }
}
