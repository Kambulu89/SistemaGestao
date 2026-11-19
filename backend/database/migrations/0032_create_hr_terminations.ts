import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Cessação do contrato de trabalho (Prompt 07, bloco 7.11).
 *
 *  - `employee_terminations`: processo de cessação (motivo, aviso prévio, último dia, indemnização só quando aplicável e
 *    sempre com base legal indicada pela empresa) com aprovação segregada. Aprovado, os dados não mudam (só a ligação
 *    ao lote de liquidação e a conclusão); concluído ou cancelado, nada muda.
 *  - `termination_settlement_lines`: liquidação final (férias não gozadas e proporcionais, aviso, indemnização, outros),
 *    cada linha com componente salarial e fundamentação; só se altera em rascunho.
 *  - `termination_tasks`: checklist de saída (acessos, equipamentos, documentos, finanças); fixa depois de concluída.
 *
 * Nenhum valor legal (dias de aviso, fórmula de indemnização) está no código: a empresa indica-os com a fonte.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'employee_terminations', (table) => {
      table.uuid('employee_id').notNullable()
      table.uuid('contract_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('reason', 30).notNullable()
      table.text('details').notNullable()
      table.uuid('disciplinary_case_id').nullable()
      table.date('notice_given_on').nullable()
      table.date('last_working_day').notNullable()
      table.integer('notice_required_days').nullable()
      table.text('notice_basis').nullable()
      table.boolean('indemnity_applicable').notNullable().defaultTo(false)
      table.text('indemnity_basis').nullable()
      table.string('currency', 3).notNullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.uuid('submitted_by').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('decided_by_membership_id').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.text('decision_note').nullable()
      table.uuid('settlement_run_id').nullable()
      table.uuid('settled_by').nullable()
      table.timestamp('settled_at', { useTz: true }).nullable()
      table.text('cancel_reason').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'contract_id', 'employment_contracts')
      tenantForeignKey(table, 'disciplinary_case_id', 'disciplinary_cases')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'settlement_run_id', 'payroll_runs')
      table.unique(['tenant_id', 'code'], { indexName: 'employee_terminations_code_unique' })
      table.index(['tenant_id', 'employee_id'], 'employee_terminations_employee_index')
      table.check(
        `reason IN ('RESIGNATION','MUTUAL_AGREEMENT','DISMISSAL_DISCIPLINARY','DISMISSAL_OBJECTIVE','END_OF_TERM',
          'PROBATION','RETIREMENT','DEATH','OTHER')`,
        [],
        'employee_terminations_reason_check'
      )
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SETTLED','CANCELLED')`,
        [],
        'employee_terminations_status_check'
      )
      table.check(
        'notice_given_on IS NULL OR notice_given_on <= last_working_day',
        [],
        'employee_terminations_notice_date_check'
      )
      table.check(
        'notice_required_days IS NULL OR (notice_required_days BETWEEN 0 AND 365 AND notice_basis IS NOT NULL)',
        [],
        'employee_terminations_notice_days_check'
      )
      table.check(
        'indemnity_applicable = (indemnity_basis IS NOT NULL)',
        [],
        'employee_terminations_indemnity_check'
      )
      table.check(
        `reason <> 'DISMISSAL_DISCIPLINARY' OR disciplinary_case_id IS NOT NULL`,
        [],
        'employee_terminations_case_check'
      )
      table.check(
        `(status IN ('APPROVED','SETTLED')) = (decided_by_membership_id IS NOT NULL AND decided_at IS NOT NULL)`,
        [],
        'employee_terminations_decision_check'
      )
      table.check(
        `(status = 'SETTLED') = (settled_at IS NOT NULL)`,
        [],
        'employee_terminations_settled_check'
      )
    })
    // Um processo em curso (ou concluído) por colaborador.
    this.schema
      .raw(`CREATE UNIQUE INDEX employee_terminations_open_unique ON employee_terminations (tenant_id, employee_id)
      WHERE status <> 'CANCELLED'`)

    createTenantTable(this, 'termination_settlement_lines', (table) => {
      table.uuid('termination_id').notNullable()
      table.string('kind', 25).notNullable()
      table.uuid('component_id').notNullable()
      table.string('description', 160).notNullable()
      table.decimal('quantity', 10, 2).nullable()
      table.decimal('rate', 18, 4).nullable()
      table.decimal('amount', 18, 2).notNullable()
      table.text('basis').notNullable()
      tenantForeignKey(table, 'termination_id', 'employee_terminations', 'CASCADE')
      tenantForeignKey(table, 'component_id', 'pay_components')
      table.index(['tenant_id', 'termination_id'], 'termination_settlement_lines_termination_index')
      table.check(
        `kind IN ('UNUSED_VACATION','PROPORTIONAL_VACATION','PROPORTIONAL_ALLOWANCE','NOTICE_PAY','INDEMNITY',
          'OTHER_EARNING','NOTICE_DEDUCTION','OTHER_DEDUCTION')`,
        [],
        'termination_settlement_lines_kind_check'
      )
      table.check('amount > 0', [], 'termination_settlement_lines_amount_check')
      table.check(
        '(quantity IS NULL) = (rate IS NULL) AND (quantity IS NULL OR (quantity > 0 AND rate > 0))',
        [],
        'termination_settlement_lines_quantity_check'
      )
    })

    createTenantTable(this, 'termination_tasks', (table) => {
      table.uuid('termination_id').notNullable()
      table.string('category', 12).notNullable()
      table.string('kind', 15).notNullable().defaultTo('MANUAL')
      table.string('title', 200).notNullable()
      table.uuid('onboarding_task_id').nullable()
      table.string('status', 15).notNullable().defaultTo('PENDING')
      table.text('notes').nullable()
      table.uuid('completed_by').nullable()
      table.timestamp('completed_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'termination_id', 'employee_terminations', 'CASCADE')
      tenantForeignKey(table, 'onboarding_task_id', 'onboarding_tasks')
      table.index(['tenant_id', 'termination_id'], 'termination_tasks_termination_index')
      table.check(
        `category IN ('ACCESS','EQUIPMENT','DOCUMENTS','FINANCE','OTHER')`,
        [],
        'termination_tasks_category_check'
      )
      table.check(
        `kind IN ('MANUAL','SYSTEM_ACCESS','LOANS','RETURN_ITEM')`,
        [],
        'termination_tasks_kind_check'
      )
      table.check(
        `status IN ('PENDING','DONE','NOT_APPLICABLE')`,
        [],
        'termination_tasks_status_check'
      )
      table.check(
        `(status = 'PENDING') = (completed_at IS NULL)`,
        [],
        'termination_tasks_completed_check'
      )
    })

    // Aprovado: só a ligação ao lote de liquidação e a conclusão mudam. Concluído ou cancelado: nada muda. Nunca se apaga.
    this.schema.raw(`
      CREATE FUNCTION employee_terminations_final() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE free text[] := ARRAY['status','settlement_run_id','settled_by','settled_at','version','updated_by',
        'updated_at'];
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status IN ('SETTLED','CANCELLED') THEN
          RAISE EXCEPTION 'TERMINATION_FINAL' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'APPROVED' AND (NEW.status NOT IN ('APPROVED','SETTLED')
            OR (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free)) THEN
          RAISE EXCEPTION 'TERMINATION_FINAL' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER employee_terminations_final BEFORE UPDATE OR DELETE ON employee_terminations
      FOR EACH ROW EXECUTE FUNCTION employee_terminations_final()`)

    // As linhas da liquidação só mudam com o processo em rascunho (a aprovação cobre os montantes).
    this.schema.raw(`
      CREATE FUNCTION termination_children_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM employee_terminations
          WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.termination_id, OLD.termination_id);
        IF (TG_TABLE_NAME = 'termination_settlement_lines' AND s IS DISTINCT FROM 'DRAFT')
          OR (TG_TABLE_NAME = 'termination_tasks' AND s IN ('SETTLED','CANCELLED')) THEN
          RAISE EXCEPTION 'TERMINATION_LOCKED' USING ERRCODE = '23000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $$`)
    for (const t of ['termination_settlement_lines', 'termination_tasks'])
      this.schema.raw(`CREATE TRIGGER ${t}_guard BEFORE INSERT OR UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION termination_children_guard()`)
  }

  async down() {
    this.schema.dropTable('termination_tasks')
    this.schema.dropTable('termination_settlement_lines')
    this.schema.dropTable('employee_terminations')
    for (const f of ['termination_children_guard', 'employee_terminations_final'])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
