import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recursos humanos (Prompt 07, bloco 7.3): contratos e carreira.
 *
 *  - `employment_contracts`: contrato de trabalho do colaborador (tipo, datas, período experimental, jornada,
 *    remuneração base em `numeric`, estado). No máximo um contrato em vigor (ACTIVE/SUSPENDED) por colaborador.
 *  - `employment_contract_amendments`: adendas e renovações, só de acréscimo, com data de efeito; as condições numa data
 *    são as do contrato com as adendas em vigor nessa data aplicadas por ordem.
 *  - `employment_contract_events`: histórico do contrato (activação, suspensão, retoma, adenda, renovação, termo).
 *  - `employment_assignments`: histórico da colocação (cargo, departamento, filial, superior, centro de custo) com
 *    vigência `[valid_from, valid_to]`; um período em aberto por colaborador; transferências e promoções fecham o
 *    período corrente e abrem outro.
 *
 * Limites legais (duração e renovações de contratos a prazo, período experimental) não estão no esquema: dependem da
 * legislação em vigor, a confirmar antes de qualquer validação legal.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'employment_contracts', (table) => {
      table.uuid('employee_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('contract_type', 20).notNullable()
      table.date('start_date').notNullable()
      table.date('end_date').nullable()
      table.date('probation_end_date').nullable()
      table.decimal('weekly_hours', 5, 2).notNullable()
      table.string('work_schedule', 200).nullable()
      table.string('currency', 3).notNullable()
      table.decimal('base_salary', 18, 2).notNullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.integer('renewal_count').notNullable().defaultTo(0)
      table.date('suspended_from').nullable()
      table.date('termination_date').nullable()
      table.text('termination_reason').nullable()
      table.text('notes').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      table.unique(['tenant_id', 'code'], { indexName: 'employment_contracts_code_unique' })
      table.index(['tenant_id', 'employee_id'], 'employment_contracts_employee_index')
      table.check(
        `contract_type IN ('PERMANENT','FIXED_TERM','UNCERTAIN_TERM')`,
        [],
        'employment_contracts_type_check'
      )
      table.check(
        `status IN ('DRAFT','ACTIVE','SUSPENDED','ENDED','CANCELLED')`,
        [],
        'employment_contracts_status_check'
      )
      table.check(
        `contract_type <> 'FIXED_TERM' OR end_date IS NOT NULL`,
        [],
        'employment_contracts_fixed_end_check'
      )
      table.check(
        'end_date IS NULL OR end_date >= start_date',
        [],
        'employment_contracts_end_check'
      )
      table.check(
        'probation_end_date IS NULL OR probation_end_date >= start_date',
        [],
        'employment_contracts_probation_check'
      )
      table.check(
        'weekly_hours > 0 AND weekly_hours <= 168',
        [],
        'employment_contracts_hours_check'
      )
      table.check('base_salary >= 0', [], 'employment_contracts_salary_check')
      table.check(
        `(status = 'ENDED') = (termination_date IS NOT NULL)`,
        [],
        'employment_contracts_termination_check'
      )
      table.check(
        'termination_date IS NULL OR termination_date >= start_date',
        [],
        'employment_contracts_termination_date_check'
      )
      table.check(
        `(status = 'SUSPENDED') = (suspended_from IS NOT NULL)`,
        [],
        'employment_contracts_suspension_check'
      )
    })
    // Um contrato em vigor por colaborador.
    this.schema.raw(`CREATE UNIQUE INDEX employment_contracts_open_unique
      ON employment_contracts (tenant_id, employee_id) WHERE status IN ('ACTIVE','SUSPENDED')`)

    createTenantTable(this, 'employment_contract_amendments', (table) => {
      table.uuid('contract_id').notNullable()
      table.integer('sequence').notNullable()
      table.string('kind', 10).notNullable()
      table.date('effective_date').notNullable()
      table.decimal('base_salary', 18, 2).nullable()
      table.decimal('weekly_hours', 5, 2).nullable()
      table.string('work_schedule', 200).nullable()
      table.date('end_date').nullable()
      table.text('reason').notNullable()
      tenantForeignKey(table, 'contract_id', 'employment_contracts')
      table.unique(['tenant_id', 'contract_id', 'sequence'], {
        indexName: 'employment_contract_amendments_sequence_unique',
      })
      table.check(`kind IN ('CHANGE','RENEWAL')`, [], 'employment_contract_amendments_kind_check')
      table.check(
        `kind <> 'RENEWAL' OR end_date IS NOT NULL`,
        [],
        'employment_contract_amendments_renewal_check'
      )
      table.check(
        'base_salary IS NOT NULL OR weekly_hours IS NOT NULL OR work_schedule IS NOT NULL OR end_date IS NOT NULL',
        [],
        'employment_contract_amendments_changes_check'
      )
      table.check(
        'base_salary IS NULL OR base_salary >= 0',
        [],
        'employment_contract_amendments_salary_check'
      )
      table.check(
        'weekly_hours IS NULL OR (weekly_hours > 0 AND weekly_hours <= 168)',
        [],
        'employment_contract_amendments_hours_check'
      )
    })

    createTenantTable(this, 'employment_contract_events', (table) => {
      table.uuid('contract_id').notNullable()
      table.string('kind', 12).notNullable()
      table.date('event_date').notNullable()
      table.text('reason').nullable()
      tenantForeignKey(table, 'contract_id', 'employment_contracts')
      table.index(['tenant_id', 'contract_id'], 'employment_contract_events_contract_index')
      table.check(
        `kind IN ('ACTIVATED','SUSPENDED','RESUMED','AMENDED','RENEWED','TERMINATED','CANCELLED')`,
        [],
        'employment_contract_events_kind_check'
      )
    })

    createTenantTable(this, 'employment_assignments', (table) => {
      table.uuid('employee_id').notNullable()
      table.string('kind', 12).notNullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.uuid('department_id').nullable()
      table.uuid('position_id').nullable()
      table.uuid('manager_id').nullable()
      table.uuid('cost_center_id').nullable()
      table.text('reason').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      tenantForeignKey(table, 'department_id', 'departments')
      tenantForeignKey(table, 'position_id', 'positions')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.index(
        ['tenant_id', 'employee_id', 'valid_from'],
        'employment_assignments_employee_index'
      )
      table.check(
        `kind IN ('HIRE','TRANSFER','PROMOTION','CHANGE')`,
        [],
        'employment_assignments_kind_check'
      )
      table.check(
        'valid_to IS NULL OR valid_to >= valid_from',
        [],
        'employment_assignments_period_check'
      )
    })
    this.schema
      .raw(`ALTER TABLE employment_assignments ADD CONSTRAINT assignment_manager_id_tenant_fk
      FOREIGN KEY (tenant_id, manager_id) REFERENCES employees (tenant_id, id) ON DELETE RESTRICT`)
    // Um período em aberto por colaborador e início único (sem dois movimentos no mesmo dia).
    this.schema.raw(`CREATE UNIQUE INDEX employment_assignments_open_unique
      ON employment_assignments (tenant_id, employee_id) WHERE valid_to IS NULL`)
    this.schema.raw(`CREATE UNIQUE INDEX employment_assignments_start_unique
      ON employment_assignments (tenant_id, employee_id, valid_from)`)
  }

  async down() {
    for (const t of [
      'employment_assignments',
      'employment_contract_events',
      'employment_contract_amendments',
      'employment_contracts',
    ])
      this.schema.dropTable(t)
  }
}
