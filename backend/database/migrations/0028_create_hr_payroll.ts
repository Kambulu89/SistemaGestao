import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Processamento salarial (Prompt 07, bloco 7.7).
 *
 *  - `payroll_rule_sets` + `payroll_irt_brackets`: regras versionadas por data de início e moeda, com fonte
 *    obrigatória (taxas de INSS, tabela progressiva de IRT, incidência do salário base, base do IRT, base de dias).
 *    Publicado ⇒ imutável. Nenhum valor legal no esquema nem no código.
 *  - `payroll_periods`: mês por entidade legal (aberto/fechado).
 *  - `payroll_runs`: lote regular, extra ou retroactivo (este aponta para um mês já fechado); um regular activo por mês.
 *  - `payroll_run_inputs`: valores variáveis do lote (horas extra, prémios pontuais, …).
 *  - `payroll_results` + `payroll_result_lines`: recibo por colaborador com o instantâneo dos dados e regras usados.
 *    Depois de aprovado o lote, os resultados não se alteram nem apagam (trigger).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'payroll_rule_sets', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('currency', 3).notNullable()
      table.date('valid_from').notNullable()
      table.decimal('inss_employee_rate', 7, 4).notNullable()
      table.decimal('inss_employer_rate', 7, 4).notNullable()
      table.boolean('base_irt_subject').notNullable()
      table.boolean('base_inss_subject').notNullable()
      table.boolean('irt_base_deducts_inss').notNullable()
      table.string('day_basis', 10).notNullable()
      table.text('legal_reference').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.uuid('published_by').nullable()
      table.timestamp('published_at', { useTz: true }).nullable()
      table.unique(['tenant_id', 'code'], { indexName: 'payroll_rule_sets_code_unique' })
      table.check(`status IN ('DRAFT','PUBLISHED')`, [], 'payroll_rule_sets_status_check')
      table.check(`day_basis IN ('CALENDAR','FIXED_30')`, [], 'payroll_rule_sets_day_basis_check')
      table.check(
        `inss_employee_rate BETWEEN 0 AND 100 AND inss_employer_rate BETWEEN 0 AND 100`,
        [],
        'payroll_rule_sets_rates_check'
      )
      table.check(`length(trim(legal_reference)) >= 5`, [], 'payroll_rule_sets_reference_check')
    })
    this.schema.raw(`CREATE UNIQUE INDEX payroll_rule_sets_published_unique ON payroll_rule_sets
      (tenant_id, currency, valid_from) WHERE status = 'PUBLISHED'`)

    createTenantTable(this, 'payroll_irt_brackets', (table) => {
      table.uuid('rule_set_id').notNullable()
      table.integer('sequence').notNullable()
      table.decimal('lower', 18, 2).notNullable()
      table.decimal('upper', 18, 2).nullable()
      table.decimal('fixed_amount', 18, 2).notNullable()
      table.decimal('rate', 7, 4).notNullable()
      table.decimal('excess_over', 18, 2).notNullable()
      tenantForeignKey(table, 'rule_set_id', 'payroll_rule_sets', 'CASCADE')
      table.unique(['tenant_id', 'rule_set_id', 'sequence'], {
        indexName: 'payroll_irt_brackets_sequence_unique',
      })
      table.check('rate BETWEEN 0 AND 100', [], 'payroll_irt_brackets_rate_check')
      table.check(
        'lower >= 0 AND fixed_amount >= 0 AND excess_over >= 0 AND (upper IS NULL OR upper >= lower)',
        [],
        'payroll_irt_brackets_amounts_check'
      )
    })

    createTenantTable(this, 'payroll_periods', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.date('period').notNullable()
      table.string('status', 10).notNullable().defaultTo('OPEN')
      table.uuid('closed_by').nullable()
      table.timestamp('closed_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'legal_entity_id', 'period'], {
        indexName: 'payroll_periods_unique',
      })
      table.check(`status IN ('OPEN','CLOSED')`, [], 'payroll_periods_status_check')
      table.check(`extract(day from period) = 1`, [], 'payroll_periods_day_check')
    })

    createTenantTable(this, 'payroll_runs', (table) => {
      table.uuid('period_id').notNullable()
      table.uuid('target_period_id').nullable()
      table.string('code', 40).notNullable()
      table.string('kind', 10).notNullable()
      table.string('description', 200).nullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.specificType('excluded_employee_ids', 'uuid[]').notNullable().defaultTo('{}')
      table.uuid('rule_set_id').nullable()
      table.string('inputs_hash', 64).nullable()
      table.uuid('calculated_by').nullable()
      table.timestamp('calculated_at', { useTz: true }).nullable()
      table.uuid('decided_by_membership_id').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.text('decision_comment').nullable()
      table.uuid('closed_by').nullable()
      table.timestamp('closed_at', { useTz: true }).nullable()
      table.integer('employees_count').notNullable().defaultTo(0)
      table.integer('errors_count').notNullable().defaultTo(0)
      table.decimal('gross', 18, 2).notNullable().defaultTo(0)
      table.decimal('inss_employee', 18, 2).notNullable().defaultTo(0)
      table.decimal('irt', 18, 2).notNullable().defaultTo(0)
      table.decimal('deductions', 18, 2).notNullable().defaultTo(0)
      table.decimal('loans', 18, 2).notNullable().defaultTo(0)
      table.decimal('net', 18, 2).notNullable().defaultTo(0)
      table.decimal('inss_employer', 18, 2).notNullable().defaultTo(0)
      table.decimal('employer_cost', 18, 2).notNullable().defaultTo(0)
      tenantForeignKey(table, 'period_id', 'payroll_periods')
      tenantForeignKey(table, 'target_period_id', 'payroll_periods')
      tenantForeignKey(table, 'rule_set_id', 'payroll_rule_sets')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'code'], { indexName: 'payroll_runs_code_unique' })
      table.index(['tenant_id', 'period_id'], 'payroll_runs_period_index')
      table.check(`kind IN ('REGULAR','EXTRA','RETRO')`, [], 'payroll_runs_kind_check')
      table.check(
        `status IN ('DRAFT','CALCULATED','PENDING_APPROVAL','APPROVED','CLOSED','CANCELLED')`,
        [],
        'payroll_runs_status_check'
      )
      table.check(
        `(kind = 'RETRO') = (target_period_id IS NOT NULL)`,
        [],
        'payroll_runs_target_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX payroll_runs_regular_unique ON payroll_runs (tenant_id, period_id)
      WHERE kind = 'REGULAR' AND status <> 'CANCELLED'`)

    createTenantTable(this, 'payroll_run_inputs', (table) => {
      table.uuid('run_id').notNullable()
      table.uuid('employee_id').notNullable()
      table.uuid('component_id').notNullable()
      table.decimal('amount', 18, 2).notNullable()
      table.string('note', 200).nullable()
      tenantForeignKey(table, 'run_id', 'payroll_runs', 'CASCADE')
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'component_id', 'pay_components')
      table.unique(['tenant_id', 'run_id', 'employee_id', 'component_id'], {
        indexName: 'payroll_run_inputs_unique',
      })
      table.check('amount > 0', [], 'payroll_run_inputs_amount_check')
    })

    createTenantTable(this, 'payroll_results', (table) => {
      table.uuid('run_id').notNullable()
      table.uuid('employee_id').notNullable()
      table.string('status', 10).notNullable()
      table.string('currency', 3).nullable()
      table.decimal('gross', 18, 2).nullable()
      table.decimal('inss_base', 18, 2).nullable()
      table.decimal('irt_base', 18, 2).nullable()
      table.decimal('inss_employee', 18, 2).nullable()
      table.decimal('irt', 18, 2).nullable()
      table.decimal('deductions', 18, 2).nullable()
      table.decimal('loans', 18, 2).nullable()
      table.decimal('net', 18, 2).nullable()
      table.decimal('inss_employer', 18, 2).nullable()
      table.decimal('employer_cost', 18, 2).nullable()
      table.jsonb('errors').notNullable().defaultTo('[]')
      table.jsonb('snapshot').notNullable()
      tenantForeignKey(table, 'run_id', 'payroll_runs', 'CASCADE')
      tenantForeignKey(table, 'employee_id', 'employees')
      table.unique(['tenant_id', 'run_id', 'employee_id'], { indexName: 'payroll_results_unique' })
      table.index(['tenant_id', 'employee_id'], 'payroll_results_employee_index')
      table.check(`status IN ('OK','ERROR')`, [], 'payroll_results_status_check')
      table.check(
        `status = 'ERROR' OR (gross IS NOT NULL AND net IS NOT NULL AND currency IS NOT NULL)`,
        [],
        'payroll_results_ok_check'
      )
    })

    createTenantTable(this, 'payroll_result_lines', (table) => {
      table.uuid('result_id').notNullable()
      table.integer('sequence').notNullable()
      table.string('code', 60).notNullable()
      table.string('name', 200).notNullable()
      table.string('kind', 10).notNullable()
      table.string('source', 15).notNullable()
      table.decimal('amount', 18, 2).notNullable()
      table.boolean('irt_subject').notNullable()
      table.boolean('inss_subject').notNullable()
      table.uuid('ref_id').nullable()
      tenantForeignKey(table, 'result_id', 'payroll_results', 'CASCADE')
      table.unique(['tenant_id', 'result_id', 'sequence'], {
        indexName: 'payroll_result_lines_sequence_unique',
      })
      table.check(
        `kind IN ('EARNING','DEDUCTION','EMPLOYER')`,
        [],
        'payroll_result_lines_kind_check'
      )
      table.check(
        `source IN ('BASE','COMPONENT','ABSENCE','LOAN','INSS','IRT','INSS_EMPLOYER')`,
        [],
        'payroll_result_lines_source_check'
      )
    })

    // Regras publicadas e resultados de lotes aprovados/fechados não mudam (documentos finalizados).
    this.schema.raw(`
      CREATE FUNCTION payroll_rule_sets_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'PUBLISHED' THEN RAISE EXCEPTION 'PAYROLL_RULES_PUBLISHED' USING ERRCODE = '23000'; END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER payroll_rule_sets_frozen BEFORE UPDATE OR DELETE ON payroll_rule_sets
      FOR EACH ROW EXECUTE FUNCTION payroll_rule_sets_frozen()`)
    this.schema.raw(`
      CREATE FUNCTION payroll_irt_brackets_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM payroll_rule_sets
          WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.rule_set_id, OLD.rule_set_id);
        IF s = 'PUBLISHED' THEN RAISE EXCEPTION 'PAYROLL_RULES_PUBLISHED' USING ERRCODE = '23000'; END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER payroll_irt_brackets_frozen BEFORE INSERT OR UPDATE OR DELETE ON payroll_irt_brackets
      FOR EACH ROW EXECUTE FUNCTION payroll_irt_brackets_frozen()`)
    this.schema.raw(`
      CREATE FUNCTION payroll_runs_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status = 'CLOSED' THEN
          RAISE EXCEPTION 'PAYROLL_RUN_FINAL' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER payroll_runs_frozen BEFORE UPDATE OR DELETE ON payroll_runs
      FOR EACH ROW EXECUTE FUNCTION payroll_runs_frozen()`)
    this.schema.raw(`
      CREATE FUNCTION payroll_results_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM payroll_runs
          WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.run_id, OLD.run_id);
        IF s IN ('PENDING_APPROVAL','APPROVED','CLOSED') THEN
          RAISE EXCEPTION 'PAYROLL_RESULTS_FINAL' USING ERRCODE = '23000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER payroll_results_frozen BEFORE INSERT OR UPDATE OR DELETE ON payroll_results
      FOR EACH ROW EXECUTE FUNCTION payroll_results_frozen()`)
    this.schema.raw(`
      CREATE FUNCTION payroll_result_lines_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT r.status INTO s FROM payroll_results p JOIN payroll_runs r ON r.tenant_id = p.tenant_id AND r.id = p.run_id
          WHERE p.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND p.id = COALESCE(NEW.result_id, OLD.result_id);
        IF s IN ('PENDING_APPROVAL','APPROVED','CLOSED') THEN
          RAISE EXCEPTION 'PAYROLL_RESULTS_FINAL' USING ERRCODE = '23000';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER payroll_result_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON payroll_result_lines
      FOR EACH ROW EXECUTE FUNCTION payroll_result_lines_frozen()`)
  }

  async down() {
    this.schema.dropTable('payroll_result_lines')
    this.schema.dropTable('payroll_results')
    this.schema.dropTable('payroll_run_inputs')
    this.schema.raw('DROP TRIGGER payroll_runs_frozen ON payroll_runs')
    this.schema.dropTable('payroll_runs')
    this.schema.dropTable('payroll_periods')
    this.schema.dropTable('payroll_irt_brackets')
    this.schema.raw('DROP TRIGGER payroll_rule_sets_frozen ON payroll_rule_sets')
    this.schema.dropTable('payroll_rule_sets')
    for (const f of [
      'payroll_result_lines_frozen',
      'payroll_results_frozen',
      'payroll_runs_frozen',
      'payroll_irt_brackets_frozen',
      'payroll_rule_sets_frozen',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
