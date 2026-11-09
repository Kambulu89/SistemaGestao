import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Formação e processos laborais (Prompt 07, bloco 7.10).
 *
 *  - `competencies`, `training_courses` (+ `training_course_competencies`): catálogo da empresa.
 *  - `training_sessions` + `training_enrollments`: sessões com custo, capacidade e resultado por participante; depois de
 *    concluída, a sessão e os resultados não mudam.
 *  - `employee_competencies`: histórico de níveis por colaborador (de formação ou de avaliação), só de acréscimo.
 *  - `employee_certificates`: certificados (emitidos pela sessão ou registados à mão), com validade.
 *  - `disciplinary_cases` + `disciplinary_events`: processos disciplinares de acesso restrito; a cronologia é só de
 *    acréscimo e um processo encerrado não muda.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'competencies', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.text('description').nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'competencies_code_unique' })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'competencies_status_check')
    })

    createTenantTable(this, 'training_courses', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.text('description').nullable()
      table.string('mode', 10).notNullable()
      table.string('provider', 160).nullable()
      table.decimal('duration_hours', 6, 2).notNullable()
      table.boolean('assessed').notNullable().defaultTo(false)
      table.boolean('issues_certificate').notNullable().defaultTo(false)
      table.integer('certificate_validity_months').nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'training_courses_code_unique' })
      table.check(`mode IN ('INTERNAL','EXTERNAL','ONLINE')`, [], 'training_courses_mode_check')
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'training_courses_status_check')
      table.check('duration_hours > 0', [], 'training_courses_hours_check')
      table.check(
        'certificate_validity_months IS NULL OR (issues_certificate AND certificate_validity_months BETWEEN 1 AND 240)',
        [],
        'training_courses_validity_check'
      )
    })

    createTenantTable(this, 'training_course_competencies', (table) => {
      table.uuid('course_id').notNullable()
      table.uuid('competency_id').notNullable()
      table.integer('level').notNullable()
      tenantForeignKey(table, 'course_id', 'training_courses', 'CASCADE')
      tenantForeignKey(table, 'competency_id', 'competencies')
      table.unique(['tenant_id', 'course_id', 'competency_id'], {
        indexName: 'training_course_competencies_unique',
      })
      table.check('level BETWEEN 1 AND 5', [], 'training_course_competencies_level_check')
    })

    createTenantTable(this, 'training_sessions', (table) => {
      table.uuid('course_id').notNullable()
      table.string('code', 40).notNullable()
      table.date('starts_on').notNullable()
      table.date('ends_on').notNullable()
      table.string('location', 200).nullable()
      table.string('trainer', 160).nullable()
      table.integer('capacity').nullable()
      table.string('currency', 3).nullable()
      table.decimal('cost_total', 18, 2).nullable()
      table.string('status', 10).notNullable().defaultTo('PLANNED')
      table.uuid('completed_by').nullable()
      table.timestamp('completed_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'course_id', 'training_courses')
      table.unique(['tenant_id', 'code'], { indexName: 'training_sessions_code_unique' })
      table.check(
        `status IN ('PLANNED','COMPLETED','CANCELLED')`,
        [],
        'training_sessions_status_check'
      )
      table.check('ends_on >= starts_on', [], 'training_sessions_dates_check')
      table.check('capacity IS NULL OR capacity > 0', [], 'training_sessions_capacity_check')
      table.check(
        '(cost_total IS NULL) = (currency IS NULL) AND (cost_total IS NULL OR cost_total >= 0)',
        [],
        'training_sessions_cost_check'
      )
    })

    createTenantTable(this, 'training_enrollments', (table) => {
      table.uuid('session_id').notNullable()
      table.uuid('employee_id').notNullable()
      table.string('status', 10).notNullable().defaultTo('ENROLLED')
      table.decimal('hours_attended', 6, 2).nullable()
      table.decimal('score', 5, 2).nullable()
      table.text('notes').nullable()
      tenantForeignKey(table, 'session_id', 'training_sessions', 'CASCADE')
      tenantForeignKey(table, 'employee_id', 'employees')
      table.unique(['tenant_id', 'session_id', 'employee_id'], {
        indexName: 'training_enrollments_unique',
      })
      table.index(['tenant_id', 'employee_id'], 'training_enrollments_employee_index')
      table.check(
        `status IN ('ENROLLED','ATTENDED','PASSED','FAILED','NO_SHOW','CANCELLED')`,
        [],
        'training_enrollments_status_check'
      )
      table.check(
        'hours_attended IS NULL OR hours_attended >= 0',
        [],
        'training_enrollments_hours_check'
      )
      table.check(
        'score IS NULL OR score BETWEEN 0 AND 100',
        [],
        'training_enrollments_score_check'
      )
    })

    createTenantTable(this, 'employee_competencies', (table) => {
      table.uuid('employee_id').notNullable()
      table.uuid('competency_id').notNullable()
      table.integer('level').notNullable()
      table.date('acquired_on').notNullable()
      table.string('source', 12).notNullable()
      table.uuid('enrollment_id').nullable()
      table.text('notes').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'competency_id', 'competencies')
      tenantForeignKey(table, 'enrollment_id', 'training_enrollments')
      table.index(['tenant_id', 'employee_id'], 'employee_competencies_employee_index')
      table.check('level BETWEEN 1 AND 5', [], 'employee_competencies_level_check')
      table.check(`source IN ('TRAINING','ASSESSMENT')`, [], 'employee_competencies_source_check')
      table.check(
        `(source = 'TRAINING') = (enrollment_id IS NOT NULL)`,
        [],
        'employee_competencies_enrollment_check'
      )
    })

    createTenantTable(this, 'employee_certificates', (table) => {
      table.uuid('employee_id').notNullable()
      table.string('name', 200).notNullable()
      table.string('issuer', 200).notNullable()
      table.string('number', 60).nullable()
      table.date('issued_on').notNullable()
      table.date('expires_on').nullable()
      table.uuid('enrollment_id').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'enrollment_id', 'training_enrollments')
      table.index(['tenant_id', 'employee_id'], 'employee_certificates_employee_index')
      table.check(
        'expires_on IS NULL OR expires_on >= issued_on',
        [],
        'employee_certificates_dates_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX employee_certificates_enrollment_unique ON employee_certificates
      (tenant_id, enrollment_id) WHERE enrollment_id IS NOT NULL`)

    createTenantTable(this, 'disciplinary_cases', (table) => {
      table.uuid('employee_id').notNullable()
      table.string('code', 30).notNullable()
      table.date('occurred_on').notNullable()
      table.string('category', 15).notNullable()
      table.string('summary', 200).notNullable()
      table.text('description').notNullable()
      table.string('status', 15).notNullable().defaultTo('OPEN')
      table.string('outcome', 20).nullable()
      table.text('outcome_details').nullable()
      table.date('decided_on').nullable()
      table.uuid('decided_by_membership_id').nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'code'], { indexName: 'disciplinary_cases_code_unique' })
      table.index(['tenant_id', 'employee_id'], 'disciplinary_cases_employee_index')
      table.check(
        `category IN ('ATTENDANCE','CONDUCT','PERFORMANCE','SAFETY','OTHER')`,
        [],
        'disciplinary_cases_category_check'
      )
      table.check(
        `status IN ('OPEN','UNDER_REVIEW','CLOSED')`,
        [],
        'disciplinary_cases_status_check'
      )
      table.check(
        `(status = 'CLOSED') = (outcome IS NOT NULL AND decided_on IS NOT NULL)`,
        [],
        'disciplinary_cases_outcome_check'
      )
      table.check(
        `outcome IS NULL OR outcome IN ('NO_ACTION','VERBAL_WARNING','WRITTEN_WARNING','SUSPENSION','DISMISSAL','OTHER')`,
        [],
        'disciplinary_cases_outcome_values_check'
      )
    })

    createTenantTable(this, 'disciplinary_events', (table) => {
      table.uuid('case_id').notNullable()
      table.string('kind', 15).notNullable()
      table.date('occurred_on').notNullable()
      table.text('text').notNullable()
      tenantForeignKey(table, 'case_id', 'disciplinary_cases')
      table.index(['tenant_id', 'case_id'], 'disciplinary_events_case_index')
      table.check(
        `kind IN ('NOTE','NOTIFICATION','HEARING','DEFENCE','DECISION','STATUS')`,
        [],
        'disciplinary_events_kind_check'
      )
    })

    // Só de acréscimo: históricos de competências e cronologia disciplinar; casos encerrados e sessões concluídas fixos.
    this.schema.raw(`
      CREATE FUNCTION hr_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'HR_APPEND_ONLY' USING ERRCODE = '23000'; END $$`)
    for (const t of ['employee_competencies', 'disciplinary_events'])
      this.schema.raw(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION hr_append_only()`)
    this.schema.raw(`
      CREATE FUNCTION disciplinary_cases_closed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status = 'CLOSED' THEN
          RAISE EXCEPTION 'DISCIPLINARY_CASE_FINAL' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER disciplinary_cases_closed BEFORE UPDATE OR DELETE ON disciplinary_cases
      FOR EACH ROW EXECUTE FUNCTION disciplinary_cases_closed()`)
    this.schema.raw(`
      CREATE FUNCTION training_enrollments_completed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM training_sessions
          WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.session_id, OLD.session_id);
        IF s = 'COMPLETED' THEN RAISE EXCEPTION 'TRAINING_SESSION_COMPLETED' USING ERRCODE = '23000'; END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $$`)
    this.schema.raw(`CREATE TRIGGER training_enrollments_completed
      BEFORE INSERT OR UPDATE OR DELETE ON training_enrollments
      FOR EACH ROW EXECUTE FUNCTION training_enrollments_completed()`)
  }

  async down() {
    this.schema.dropTable('disciplinary_events')
    this.schema.dropTable('disciplinary_cases')
    this.schema.dropTable('employee_certificates')
    this.schema.dropTable('employee_competencies')
    this.schema.dropTable('training_enrollments')
    this.schema.dropTable('training_sessions')
    this.schema.dropTable('training_course_competencies')
    this.schema.dropTable('training_courses')
    this.schema.dropTable('competencies')
    for (const f of [
      'training_enrollments_completed',
      'disciplinary_cases_closed',
      'hr_append_only',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
