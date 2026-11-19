import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recursos humanos (Prompt 07, bloco 7.6): adiantamentos e empréstimos a colaboradores.
 *
 *  - `employee_loans`: o "contrato" do adiantamento/empréstimo (capital, prestações, primeiro mês, motivo, estado).
 *  - `employee_loan_installments`: plano de prestações mensais; cada prestação é liquidada uma única vez — por desconto
 *    no processamento (`DEDUCTED`, com a referência do processamento) ou por pagamento directo (`PAID`).
 *  - `hr_settings`: limites configuráveis (prestação máxima em % do salário base, número máximo de prestações) e a
 *    respectiva fonte; nada fixado no esquema.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'employee_loans', (table) => {
      table.uuid('employee_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('kind', 10).notNullable()
      table.string('currency', 3).notNullable()
      table.decimal('principal', 18, 2).notNullable()
      table.integer('installments_count').notNullable()
      table.date('first_period').notNullable()
      table.text('reason').notNullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.uuid('decided_by_membership_id').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.text('decision_comment').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'code'], { indexName: 'employee_loans_code_unique' })
      table.index(['tenant_id', 'employee_id'], 'employee_loans_employee_index')
      table.check(`kind IN ('ADVANCE','LOAN')`, [], 'employee_loans_kind_check')
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','SETTLED','REJECTED','CANCELLED')`,
        [],
        'employee_loans_status_check'
      )
      table.check('principal > 0', [], 'employee_loans_principal_check')
      table.check('installments_count BETWEEN 1 AND 120', [], 'employee_loans_count_check')
      table.check(`kind <> 'ADVANCE' OR installments_count = 1`, [], 'employee_loans_advance_check')
      table.check(`extract(day from first_period) = 1`, [], 'employee_loans_period_check')
    })

    createTenantTable(this, 'employee_loan_installments', (table) => {
      table.uuid('loan_id').notNullable()
      table.integer('sequence').notNullable()
      table.date('due_period').notNullable()
      table.decimal('amount', 18, 2).notNullable()
      table.string('status', 10).notNullable().defaultTo('PENDING')
      table.string('settlement_reference', 80).nullable()
      table.date('settled_on').nullable()
      table.text('settlement_note').nullable()
      tenantForeignKey(table, 'loan_id', 'employee_loans', 'CASCADE')
      table.unique(['tenant_id', 'loan_id', 'sequence'], {
        indexName: 'employee_loan_installments_sequence_unique',
      })
      table.index(['tenant_id', 'due_period'], 'employee_loan_installments_period_index')
      table.check(
        `status IN ('PENDING','DEDUCTED','PAID','CANCELLED')`,
        [],
        'employee_loan_installments_status_check'
      )
      table.check('amount > 0', [], 'employee_loan_installments_amount_check')
      // Liquidada ⇔ com referência e data: nunca "descontada" sem rasto, nem duas vezes (só sai de PENDING).
      table.check(
        `(status IN ('DEDUCTED','PAID')) = (settlement_reference IS NOT NULL AND settled_on IS NOT NULL)`,
        [],
        'employee_loan_installments_settlement_check'
      )
      table.check(`extract(day from due_period) = 1`, [], 'employee_loan_installments_period_check')
    })

    this.schema.alterTable('hr_settings', (table) => {
      table.decimal('loan_max_installment_percent', 5, 2).nullable()
      table.integer('loan_max_installments').nullable()
      table.text('loan_policy_reference').nullable()
    })
    this.schema.raw(`ALTER TABLE hr_settings ADD CONSTRAINT hr_settings_loan_limits_check CHECK (
      (loan_max_installment_percent IS NULL OR (loan_max_installment_percent > 0 AND loan_max_installment_percent <= 100))
      AND (loan_max_installments IS NULL OR loan_max_installments BETWEEN 1 AND 120)
      AND ((loan_max_installment_percent IS NULL AND loan_max_installments IS NULL) OR loan_policy_reference IS NOT NULL))`)
  }

  async down() {
    this.schema.raw('ALTER TABLE hr_settings DROP CONSTRAINT hr_settings_loan_limits_check')
    this.schema.alterTable('hr_settings', (table) => {
      table.dropColumn('loan_max_installment_percent')
      table.dropColumn('loan_max_installments')
      table.dropColumn('loan_policy_reference')
    })
    this.schema.dropTable('employee_loan_installments')
    this.schema.dropTable('employee_loans')
  }
}
