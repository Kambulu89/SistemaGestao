import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recursos humanos (Prompt 07, bloco 7.4): férias e ausências.
 *
 *  - `leave_types`: tipos de ausência da empresa (pago, desconta saldo, dias úteis ou de calendário, documento,
 *    confidencial — ex.: doença).
 *  - `leave_policies`: política de férias versionada (código + versão), com fonte legal, calendário, dias anuais, regra
 *    do primeiro ano, arredondamento e transporte. Publicada não se altera: muda-se por nova versão.
 *  - `leave_ledger`: conta-corrente de dias por colaborador e ano, só de acréscimo (direito, transporte, expiração,
 *    ajuste, gozo, reversão); o saldo é a soma.
 *  - `leave_requests`: pedidos com dias calculados pelo servidor, decisão e cancelamento.
 *
 * Dias em `numeric(6,2)`; nenhum valor legal fixado no esquema.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'leave_types', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.string('category', 20).notNullable()
      table.boolean('paid').notNullable()
      table.boolean('deducts_balance').notNullable()
      table.string('counting', 15).notNullable()
      table.boolean('requires_document').notNullable().defaultTo(false)
      table.boolean('confidential').notNullable().defaultTo(false)
      table.decimal('max_days_per_request', 6, 2).nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'leave_types_code_unique' })
      table.check(
        `category IN ('VACATION','SICK','MATERNITY','PATERNITY','BEREAVEMENT','MARRIAGE','UNPAID','OTHER')`,
        [],
        'leave_types_category_check'
      )
      table.check(`counting IN ('WORKING_DAYS','CALENDAR_DAYS')`, [], 'leave_types_counting_check')
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'leave_types_status_check')
      table.check(
        'max_days_per_request IS NULL OR max_days_per_request > 0',
        [],
        'leave_types_max_check'
      )
    })

    createTenantTable(this, 'leave_policies', (table) => {
      table.string('code', 30).notNullable()
      table.integer('policy_version').notNullable()
      table.string('name', 160).notNullable()
      table.uuid('legal_entity_id').nullable()
      table.uuid('calendar_id').notNullable()
      table.decimal('annual_days', 5, 2).notNullable()
      table.string('first_year_rule', 25).notNullable()
      table.decimal('first_year_days_per_month', 5, 2).nullable()
      table.string('rounding', 15).notNullable().defaultTo('NONE')
      table.decimal('carryover_max_days', 5, 2).notNullable().defaultTo(0)
      table.text('legal_reference').notNullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.timestamp('published_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'calendar_id', 'calendars')
      table.unique(['tenant_id', 'code', 'policy_version'], {
        indexName: 'leave_policies_version_unique',
      })
      table.check(`status IN ('DRAFT','ACTIVE','RETIRED')`, [], 'leave_policies_status_check')
      table.check(
        `first_year_rule IN ('FULL','PROPORTIONAL_MONTHS','DAYS_PER_MONTH')`,
        [],
        'leave_policies_first_year_check'
      )
      table.check(
        `first_year_rule <> 'DAYS_PER_MONTH' OR first_year_days_per_month IS NOT NULL`,
        [],
        'leave_policies_per_month_check'
      )
      table.check(
        `rounding IN ('NONE','HALF_DAY_UP','DAY_UP')`,
        [],
        'leave_policies_rounding_check'
      )
      table.check('annual_days >= 0 AND carryover_max_days >= 0', [], 'leave_policies_days_check')
      table.check('valid_to IS NULL OR valid_to >= valid_from', [], 'leave_policies_period_check')
    })
    // Só uma versão em vigor e em aberto por código.
    this.schema
      .raw(`CREATE UNIQUE INDEX leave_policies_open_unique ON leave_policies (tenant_id, code)
      WHERE status = 'ACTIVE' AND valid_to IS NULL`)

    createTenantTable(this, 'leave_requests', (table) => {
      table.uuid('employee_id').notNullable()
      table.uuid('leave_type_id').notNullable()
      table.date('start_date').notNullable()
      table.date('end_date').notNullable()
      table.decimal('days', 6, 2).notNullable()
      table.integer('year').notNullable()
      table.string('status', 10).notNullable().defaultTo('PENDING')
      table.text('reason').nullable()
      table.uuid('decided_by_membership_id').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.text('decision_comment').nullable()
      table.text('cancel_reason').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'leave_type_id', 'leave_types')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'employee_id', 'start_date'], 'leave_requests_employee_index')
      table.index(['tenant_id', 'status'], 'leave_requests_status_index')
      table.check(
        `status IN ('PENDING','APPROVED','REJECTED','CANCELLED')`,
        [],
        'leave_requests_status_check'
      )
      table.check('end_date >= start_date', [], 'leave_requests_period_check')
      table.check('days > 0', [], 'leave_requests_days_check')
    })

    createTenantTable(this, 'leave_ledger', (table) => {
      table.uuid('employee_id').notNullable()
      table.integer('year').notNullable()
      table.string('kind', 12).notNullable()
      table.decimal('days', 6, 2).notNullable()
      table.date('effective_date').notNullable()
      table.uuid('leave_request_id').nullable()
      table.uuid('policy_id').nullable()
      table.text('reason').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'leave_request_id', 'leave_requests')
      tenantForeignKey(table, 'policy_id', 'leave_policies')
      table.index(['tenant_id', 'employee_id', 'year'], 'leave_ledger_employee_year_index')
      table.check(
        `kind IN ('ACCRUAL','CARRYOVER','EXPIRY','ADJUSTMENT','TAKEN','REVERSAL')`,
        [],
        'leave_ledger_kind_check'
      )
      table.check(`kind <> 'TAKEN' OR days < 0`, [], 'leave_ledger_taken_check')
      table.check(
        `(kind IN ('TAKEN','REVERSAL')) = (leave_request_id IS NOT NULL)`,
        [],
        'leave_ledger_request_check'
      )
    })
    // Idempotência: um direito, um transporte e uma expiração por colaborador e ano; um gozo e uma reversão por pedido.
    for (const kind of ['ACCRUAL', 'CARRYOVER', 'EXPIRY'])
      this.schema.raw(`CREATE UNIQUE INDEX leave_ledger_${kind.toLowerCase()}_unique
        ON leave_ledger (tenant_id, employee_id, year) WHERE kind = '${kind}'`)
    for (const kind of ['TAKEN', 'REVERSAL'])
      this.schema.raw(`CREATE UNIQUE INDEX leave_ledger_${kind.toLowerCase()}_unique
        ON leave_ledger (tenant_id, leave_request_id) WHERE kind = '${kind}'`)
  }

  async down() {
    for (const t of ['leave_ledger', 'leave_requests', 'leave_policies', 'leave_types'])
      this.schema.dropTable(t)
  }
}
