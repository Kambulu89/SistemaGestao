import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recibos, pagamento e contabilização (Prompt 07, bloco 7.9).
 *
 *  - `payroll_obligations`: o que o fecho de um lote deixa a pagar (líquido aos colaboradores, IRT, INSS, outros
 *    descontos a terceiros), por moeda. Fechado ≠ pago: o estado vem dos pagamentos.
 *  - `payroll_obligation_payments`: pagamentos registados (só de acréscimo), nunca acima do valor em dívida.
 *  - `payroll_postings`: ligação aos eventos do motor de contabilização (o processamento e cada pagamento), uma vez.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'payroll_obligations', (table) => {
      table.uuid('run_id').notNullable()
      table.string('kind', 12).notNullable()
      table.string('currency', 3).notNullable()
      table.decimal('amount', 18, 2).notNullable()
      table.decimal('paid_amount', 18, 2).notNullable().defaultTo(0)
      table.date('due_date').nullable()
      tenantForeignKey(table, 'run_id', 'payroll_runs')
      table.unique(['tenant_id', 'run_id', 'kind', 'currency'], {
        indexName: 'payroll_obligations_unique',
      })
      table.check(
        `kind IN ('NET_PAY','IRT','INSS','DEDUCTIONS')`,
        [],
        'payroll_obligations_kind_check'
      )
      table.check(
        'amount > 0 AND paid_amount >= 0 AND paid_amount <= amount',
        [],
        'payroll_obligations_amount_check'
      )
    })

    createTenantTable(this, 'payroll_obligation_payments', (table) => {
      table.uuid('obligation_id').notNullable()
      table.integer('sequence').notNullable()
      table.decimal('amount', 18, 2).notNullable()
      table.date('paid_on').notNullable()
      table.string('reference', 80).notNullable()
      table.uuid('bank_account_id').nullable()
      table.text('note').nullable()
      tenantForeignKey(table, 'obligation_id', 'payroll_obligations')
      tenantForeignKey(table, 'bank_account_id', 'bank_accounts')
      table.unique(['tenant_id', 'obligation_id', 'sequence'], {
        indexName: 'payroll_obligation_payments_sequence_unique',
      })
      table.check('amount > 0', [], 'payroll_obligation_payments_amount_check')
    })
    this.schema.raw(`
      CREATE FUNCTION payroll_payments_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'PAYROLL_PAYMENTS_APPEND_ONLY' USING ERRCODE = '23000'; END $$`)
    this.schema.raw(`CREATE TRIGGER payroll_obligation_payments_append_only
      BEFORE UPDATE OR DELETE ON payroll_obligation_payments
      FOR EACH ROW EXECUTE FUNCTION payroll_payments_append_only()`)

    createTenantTable(this, 'payroll_postings', (table) => {
      table.uuid('run_id').notNullable()
      table.uuid('payment_id').nullable()
      table.string('kind', 10).notNullable()
      table.string('currency', 3).notNullable()
      table.uuid('posting_event_id').notNullable()
      tenantForeignKey(table, 'run_id', 'payroll_runs')
      tenantForeignKey(table, 'payment_id', 'payroll_obligation_payments')
      tenantForeignKey(table, 'posting_event_id', 'posting_events')
      table.check(`kind IN ('ACCRUAL','PAYMENT')`, [], 'payroll_postings_kind_check')
      table.check(
        `(kind = 'PAYMENT') = (payment_id IS NOT NULL)`,
        [],
        'payroll_postings_payment_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX payroll_postings_accrual_unique ON payroll_postings
      (tenant_id, run_id, currency) WHERE kind = 'ACCRUAL'`)
    this.schema.raw(`CREATE UNIQUE INDEX payroll_postings_payment_unique ON payroll_postings
      (tenant_id, payment_id) WHERE kind = 'PAYMENT'`)
  }

  async down() {
    this.schema.dropTable('payroll_postings')
    this.schema.dropTable('payroll_obligation_payments')
    this.schema.raw('DROP FUNCTION payroll_payments_append_only()')
    this.schema.dropTable('payroll_obligations')
  }
}
