import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recursos humanos (Prompt 07, bloco 7.2): recrutamento e onboarding.
 *
 *  - `hr_settings`: workflows de aprovação (opcionais) das vagas e das propostas; um registo por empresa.
 *  - `job_requisitions`: vaga autorizada (cargo da estrutura, requisitos, quantidade, prazo, remuneração autorizada).
 *  - `candidates`: pessoa candidata (dados mínimos); não é colaborador nem utilizador.
 *  - `job_applications`: candidatura de um candidato a uma vaga (uma por par), com a etapa do processo.
 *  - `job_interviews` e `job_evaluations`: entrevistas marcadas e avaliações (só de acréscimo; uma por avaliador e
 *    entrevista).
 *  - `job_offers`: proposta com salário dentro da remuneração autorizada da vaga; aprovada, respondida e convertida
 *    em colaborador (uma proposta em curso por candidatura).
 *  - `onboarding_tasks`: checklist de entrada do colaborador (documentos, conta, acessos, equipamentos).
 *
 * Dinheiro em `numeric` (nunca float).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'hr_settings', (table) => {
      table.uuid('requisition_workflow_id').nullable()
      table.uuid('offer_workflow_id').nullable()
      tenantForeignKey(table, 'requisition_workflow_id', 'approval_workflows')
      tenantForeignKey(table, 'offer_workflow_id', 'approval_workflows')
      table.unique(['tenant_id'], { indexName: 'hr_settings_tenant_unique' })
    })

    createTenantTable(this, 'job_requisitions', (table) => {
      table.string('code', 30).notNullable()
      table.string('title', 160).notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.uuid('department_id').nullable()
      table.uuid('position_id').notNullable()
      table.text('requirements').nullable()
      table.text('justification').nullable()
      table.integer('quantity').notNullable()
      table.date('deadline').nullable()
      table.string('currency', 3).notNullable()
      table.decimal('salary_min', 18, 2).notNullable()
      table.decimal('salary_max', 18, 2).notNullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.uuid('approval_request_id').nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.text('rejection_reason').nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      tenantForeignKey(table, 'department_id', 'departments')
      tenantForeignKey(table, 'position_id', 'positions')
      tenantForeignKey(table, 'approval_request_id', 'approval_requests')
      table.unique(['tenant_id', 'code'], { indexName: 'job_requisitions_code_unique' })
      table.index(['tenant_id', 'status'], 'job_requisitions_status_index')
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','OPEN','FILLED','CLOSED','CANCELLED')`,
        [],
        'job_requisitions_status_check'
      )
      table.check('quantity BETWEEN 1 AND 1000', [], 'job_requisitions_quantity_check')
      table.check(
        'salary_min >= 0 AND salary_min <= salary_max',
        [],
        'job_requisitions_salary_range_check'
      )
    })

    createTenantTable(this, 'candidates', (table) => {
      table.string('full_name', 160).notNullable()
      table.string('email', 254).nullable()
      table.string('phone', 40).nullable()
      table.string('source', 60).nullable()
      table.text('notes').nullable()
      table.check('email IS NOT NULL OR phone IS NOT NULL', [], 'candidates_contact_check')
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX candidates_email_unique ON candidates (tenant_id, lower(email))
      WHERE email IS NOT NULL`)

    createTenantTable(this, 'job_applications', (table) => {
      table.uuid('requisition_id').notNullable()
      table.uuid('candidate_id').notNullable()
      table.string('stage', 12).notNullable().defaultTo('APPLIED')
      table.text('stage_reason').nullable()
      table.uuid('employee_id').nullable()
      tenantForeignKey(table, 'requisition_id', 'job_requisitions')
      tenantForeignKey(table, 'candidate_id', 'candidates')
      tenantForeignKey(table, 'employee_id', 'employees')
      table.unique(['tenant_id', 'requisition_id', 'candidate_id'], {
        indexName: 'job_applications_unique',
      })
      table.index(['tenant_id', 'candidate_id'], 'job_applications_candidate_index')
      table.check(
        `stage IN ('APPLIED','SCREENING','INTERVIEW','OFFER','HIRED','REJECTED','WITHDRAWN')`,
        [],
        'job_applications_stage_check'
      )
      table.check(
        `(stage = 'HIRED') = (employee_id IS NOT NULL)`,
        [],
        'job_applications_hired_check'
      )
    })

    createTenantTable(this, 'job_interviews', (table) => {
      table.uuid('application_id').notNullable()
      table.timestamp('scheduled_at', { useTz: true }).notNullable()
      table.integer('duration_minutes').notNullable()
      table.string('mode', 10).notNullable()
      table.string('location', 200).nullable()
      table.uuid('interviewer_membership_id').notNullable()
      table.string('status', 10).notNullable().defaultTo('SCHEDULED')
      tenantForeignKey(table, 'application_id', 'job_applications')
      tenantForeignKey(table, 'interviewer_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'application_id'], 'job_interviews_application_index')
      table.index(['tenant_id', 'interviewer_membership_id'], 'job_interviews_interviewer_index')
      table.check(`mode IN ('ONSITE','VIDEO','PHONE')`, [], 'job_interviews_mode_check')
      table.check(`status IN ('SCHEDULED','DONE','CANCELLED')`, [], 'job_interviews_status_check')
      table.check('duration_minutes BETWEEN 5 AND 480', [], 'job_interviews_duration_check')
    })

    createTenantTable(this, 'job_evaluations', (table) => {
      table.uuid('application_id').notNullable()
      table.uuid('interview_id').nullable()
      table.uuid('evaluator_membership_id').notNullable()
      table.integer('score').notNullable()
      table.string('recommendation', 10).notNullable()
      table.text('comments').nullable()
      tenantForeignKey(table, 'application_id', 'job_applications')
      tenantForeignKey(table, 'interview_id', 'job_interviews')
      tenantForeignKey(table, 'evaluator_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'application_id'], 'job_evaluations_application_index')
      table.check('score BETWEEN 1 AND 5', [], 'job_evaluations_score_check')
      table.check(
        `recommendation IN ('HIRE','HOLD','REJECT')`,
        [],
        'job_evaluations_recommendation_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX job_evaluations_interview_unique
      ON job_evaluations (tenant_id, interview_id, evaluator_membership_id) WHERE interview_id IS NOT NULL`)

    createTenantTable(this, 'job_offers', (table) => {
      table.uuid('application_id').notNullable()
      table.string('currency', 3).notNullable()
      table.decimal('salary', 18, 2).notNullable()
      table.date('start_date').notNullable()
      table.date('expires_on').nullable()
      table.text('conditions').nullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.uuid('approval_request_id').nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.text('rejection_reason').nullable()
      table.timestamp('responded_at', { useTz: true }).nullable()
      table.uuid('employee_id').nullable()
      tenantForeignKey(table, 'application_id', 'job_applications')
      tenantForeignKey(table, 'approval_request_id', 'approval_requests')
      tenantForeignKey(table, 'employee_id', 'employees')
      table.index(['tenant_id', 'application_id'], 'job_offers_application_index')
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','APPROVED','ACCEPTED','DECLINED','HIRED','CANCELLED')`,
        [],
        'job_offers_status_check'
      )
      table.check('salary > 0', [], 'job_offers_salary_check')
      table.check(`(status = 'HIRED') = (employee_id IS NOT NULL)`, [], 'job_offers_hired_check')
    })
    // Uma proposta em curso por candidatura (as recusadas, canceladas e contratadas ficam no histórico).
    this.schema
      .raw(`CREATE UNIQUE INDEX job_offers_active_unique ON job_offers (tenant_id, application_id)
      WHERE status IN ('DRAFT','PENDING_APPROVAL','APPROVED','ACCEPTED')`)
    this.schema
      .raw(`CREATE UNIQUE INDEX job_offers_employee_unique ON job_offers (tenant_id, employee_id)
      WHERE employee_id IS NOT NULL`)

    createTenantTable(this, 'onboarding_tasks', (table) => {
      table.uuid('employee_id').notNullable()
      table.string('category', 12).notNullable()
      table.string('title', 160).notNullable()
      table.date('due_date').nullable()
      table.uuid('assignee_membership_id').nullable()
      table.string('status', 16).notNullable().defaultTo('PENDING')
      table.text('notes').nullable()
      table.uuid('completed_by').nullable()
      table.timestamp('completed_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'employee_id', 'employees')
      tenantForeignKey(table, 'assignee_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'employee_id'], 'onboarding_tasks_employee_index')
      table.check(
        `category IN ('DOCUMENTS','ACCOUNT','ACCESS','EQUIPMENT','OTHER')`,
        [],
        'onboarding_tasks_category_check'
      )
      table.check(
        `status IN ('PENDING','DONE','NOT_APPLICABLE')`,
        [],
        'onboarding_tasks_status_check'
      )
      table.check(
        `(status = 'PENDING') = (completed_at IS NULL)`,
        [],
        'onboarding_tasks_completed_check'
      )
    })
  }

  async down() {
    for (const t of [
      'onboarding_tasks',
      'job_offers',
      'job_evaluations',
      'job_interviews',
      'job_applications',
      'candidates',
      'job_requisitions',
      'hr_settings',
    ])
      this.schema.dropTable(t)
  }
}
