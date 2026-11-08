import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recursos humanos (Prompt 07, bloco 7.5): compensação e benefícios.
 *
 *  - `pay_components`: catálogo da empresa (subsídios, prémios, horas extra, abonos, descontos) e forma de cálculo
 *    (montante fixo, percentagem do salário base do contrato, ou variável por período).
 *  - `pay_component_incidences`: incidência de IRT e INSS por data de início, com fonte; só de acréscimo.
 *  - `compensation_proposals` / `compensation_proposal_lines`: propostas de alteração com aprovação.
 *  - `employee_pay_items`: componentes do colaborador com vigência, criados só pela aplicação de propostas aprovadas;
 *    nunca se apagam nem se reescrevem (só se fecha o período em aberto).
 *
 * O salário base continua no contrato (7.3). Dinheiro em `numeric`; percentagens em `numeric(7,4)`.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'pay_components', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.string('kind', 10).notNullable()
      table.string('category', 12).notNullable()
      table.string('calculation', 16).notNullable()
      table.boolean('recurring').notNullable().defaultTo(true)
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'pay_components_code_unique' })
      table.check(`kind IN ('EARNING','DEDUCTION')`, [], 'pay_components_kind_check')
      table.check(
        `category IN ('ALLOWANCE','BONUS','OVERTIME','BENEFIT','DEDUCTION','OTHER')`,
        [],
        'pay_components_category_check'
      )
      table.check(
        `(category = 'DEDUCTION') = (kind = 'DEDUCTION')`,
        [],
        'pay_components_kind_category_check'
      )
      table.check(
        `calculation IN ('FIXED','PERCENT_OF_BASE','VARIABLE')`,
        [],
        'pay_components_calculation_check'
      )
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'pay_components_status_check')
    })

    createTenantTable(this, 'pay_component_incidences', (table) => {
      table.uuid('component_id').notNullable()
      table.date('valid_from').notNullable()
      table.boolean('irt_subject').notNullable()
      table.decimal('irt_exempt_amount', 18, 2).nullable()
      table.boolean('inss_subject').notNullable()
      table.text('legal_reference').notNullable()
      tenantForeignKey(table, 'component_id', 'pay_components')
      table.unique(['tenant_id', 'component_id', 'valid_from'], {
        indexName: 'pay_component_incidences_from_unique',
      })
      table.check(
        'irt_exempt_amount IS NULL OR (irt_subject AND irt_exempt_amount > 0)',
        [],
        'pay_component_incidences_exempt_check'
      )
    })

    createTenantTable(this, 'compensation_proposals', (table) => {
      table.uuid('employee_id').notNullable()
      table.date('effective_date').notNullable()
      table.text('reason').notNullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.uuid('approval_request_id').nullable()
      table.uuid('decided_by_membership_id').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.text('decision_comment').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'approval_request_id', 'approval_requests')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'employee_id'], 'compensation_proposals_employee_index')
      table.index(['tenant_id', 'status'], 'compensation_proposals_status_index')
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','APPLIED','REJECTED','CANCELLED')`,
        [],
        'compensation_proposals_status_check'
      )
    })

    createTenantTable(this, 'compensation_proposal_lines', (table) => {
      table.uuid('proposal_id').notNullable()
      table.uuid('component_id').notNullable()
      table.string('action', 8).notNullable()
      table.decimal('amount', 18, 2).nullable()
      table.decimal('percent', 7, 4).nullable()
      tenantForeignKey(table, 'proposal_id', 'compensation_proposals', 'CASCADE')
      tenantForeignKey(table, 'component_id', 'pay_components')
      table.unique(['tenant_id', 'proposal_id', 'component_id'], {
        indexName: 'compensation_proposal_lines_unique',
      })
      table.check(`action IN ('SET','REMOVE')`, [], 'compensation_proposal_lines_action_check')
      table.check(
        `(action = 'REMOVE' AND amount IS NULL AND percent IS NULL) OR
         (action = 'SET' AND ((amount IS NULL) <> (percent IS NULL)))`,
        [],
        'compensation_proposal_lines_value_check'
      )
    })

    createTenantTable(this, 'employee_pay_items', (table) => {
      table.uuid('employee_id').notNullable()
      table.uuid('component_id').notNullable()
      table.decimal('amount', 18, 2).nullable()
      table.decimal('percent', 7, 4).nullable()
      table.string('currency', 3).notNullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.uuid('proposal_id').notNullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'component_id', 'pay_components')
      tenantForeignKey(table, 'proposal_id', 'compensation_proposals')
      table.index(['tenant_id', 'employee_id'], 'employee_pay_items_employee_index')
      table.check('(amount IS NULL) <> (percent IS NULL)', [], 'employee_pay_items_value_check')
      table.check('amount IS NULL OR amount > 0', [], 'employee_pay_items_amount_check')
      table.check(
        'percent IS NULL OR (percent > 0 AND percent <= 100)',
        [],
        'employee_pay_items_percent_check'
      )
      table.check(
        'valid_to IS NULL OR valid_to >= valid_from',
        [],
        'employee_pay_items_period_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX employee_pay_items_open_unique
      ON employee_pay_items (tenant_id, employee_id, component_id) WHERE valid_to IS NULL`)
    this.schema.raw(`CREATE UNIQUE INDEX employee_pay_items_from_unique
      ON employee_pay_items (tenant_id, employee_id, component_id, valid_from)`)

    // Workflow (opcional) das propostas de compensação, ao lado dos do recrutamento.
    this.schema.alterTable('hr_settings', (table) => {
      table.uuid('compensation_workflow_id').nullable()
      tenantForeignKey(table, 'compensation_workflow_id', 'approval_workflows')
    })
  }

  async down() {
    this.schema.alterTable('hr_settings', (table) => {
      table.dropForeign(
        ['tenant_id', 'compensation_workflow_id'],
        'compensation_workflow_id_tenant_fk'
      )
      table.dropColumn('compensation_workflow_id')
    })
    for (const t of [
      'employee_pay_items',
      'compensation_proposal_lines',
      'compensation_proposals',
      'pay_component_incidences',
      'pay_components',
    ])
      this.schema.dropTable(t)
  }
}
