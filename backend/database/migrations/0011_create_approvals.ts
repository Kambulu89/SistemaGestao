import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Aprovações (bloco 3.6), por tenant com RLS e FKs compostas:
 *  - `approval_workflows` + `approval_workflow_steps`: definição com etapas ordenadas; aprovador por perfil ou por
 *    membro e número de aprovações exigido. Só se altera em DRAFT; publicada fica imutável (trigger).
 *  - `approval_requests`: pedido sobre um assunto (`subject_type`/`subject_id`), com etapa corrente e estado.
 *  - `approval_decisions`: decisões só de acrescentar; um voto por pessoa e por aprovador elegível em cada etapa.
 *  - `approval_delegations`: quem delega, em quem, período e (opcional) só para um workflow.
 */
export default class extends BaseSchema {
  async up() {
    const runtime = env.get('DB_USER')

    createTenantTable(this, 'approval_workflows', (table) => {
      table.string('code', 40).notNullable()
      table.string('name', 160).notNullable()
      table.text('description').nullable()
      table.string('subject_type', 60).notNullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.timestamp('published_at', { useTz: true }).nullable()
      table.unique(['tenant_id', 'code'], { indexName: 'approval_workflows_code_unique' })
      table.check("status IN ('DRAFT', 'ACTIVE', 'RETIRED')", [], 'approval_workflows_status_check')
    })

    createTenantTable(this, 'approval_workflow_steps', (table) => {
      table.uuid('workflow_id').notNullable()
      table.smallint('sequence').notNullable()
      table.string('name', 120).notNullable()
      table.string('approver_type', 10).notNullable()
      table.uuid('approver_role_id').nullable()
      table.uuid('approver_membership_id').nullable()
      table.smallint('required_approvals').notNullable().defaultTo(1)
      tenantForeignKey(table, 'workflow_id', 'approval_workflows', 'CASCADE')
      tenantForeignKey(table, 'approver_role_id', 'roles')
      tenantForeignKey(table, 'approver_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'workflow_id', 'sequence'], {
        indexName: 'approval_steps_sequence_unique',
      })
      table.check('sequence >= 1', [], 'approval_steps_sequence_check')
      table.check('required_approvals BETWEEN 1 AND 20', [], 'approval_steps_required_check')
      table.check(
        `(approver_type = 'ROLE' AND approver_role_id IS NOT NULL AND approver_membership_id IS NULL)
         OR (approver_type = 'MEMBER' AND approver_membership_id IS NOT NULL AND approver_role_id IS NULL)`,
        [],
        'approval_steps_approver_check'
      )
    })
    // Etapas só mudam enquanto o workflow está em DRAFT.
    this.schema.raw(`
      CREATE FUNCTION approval_steps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wf_status text;
      BEGIN
        SELECT status INTO wf_status FROM approval_workflows
         WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.workflow_id, OLD.workflow_id);
        IF wf_status IS NOT NULL AND wf_status <> 'DRAFT' THEN
          RAISE EXCEPTION 'APPROVAL_WORKFLOW_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER approval_steps_guard BEFORE INSERT OR UPDATE OR DELETE ON approval_workflow_steps
      FOR EACH ROW EXECUTE FUNCTION approval_steps_guard()`)

    createTenantTable(this, 'approval_requests', (table) => {
      table.uuid('workflow_id').notNullable()
      table.string('subject_type', 60).notNullable()
      table.uuid('subject_id').nullable()
      table.string('title', 200).notNullable()
      table.text('description').nullable()
      table.string('status', 12).notNullable().defaultTo('PENDING')
      table.smallint('current_step').nullable()
      table.uuid('requested_by_membership_id').notNullable()
      table.timestamp('completed_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'workflow_id', 'approval_workflows')
      tenantForeignKey(table, 'requested_by_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'status'], 'approval_requests_status_index')
      table.index(['tenant_id', 'subject_type', 'subject_id'], 'approval_requests_subject_index')
      table.check(
        "status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')",
        [],
        'approval_requests_status_check'
      )
      table.check(
        "(status = 'PENDING') = (current_step IS NOT NULL)",
        [],
        'approval_requests_step_check'
      )
    })

    createTenantTable(this, 'approval_decisions', (table) => {
      table.uuid('request_id').notNullable()
      table.smallint('step_sequence').notNullable()
      table.uuid('decided_by_membership_id').notNullable()
      table.uuid('on_behalf_of_membership_id').nullable()
      table.string('decision', 10).notNullable()
      table.text('comment').nullable()
      tenantForeignKey(table, 'request_id', 'approval_requests')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'on_behalf_of_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'request_id', 'step_sequence', 'decided_by_membership_id'], {
        indexName: 'approval_decisions_person_unique',
      })
      table.check("decision IN ('APPROVE', 'REJECT')", [], 'approval_decisions_decision_check')
      table.check(
        'on_behalf_of_membership_id IS NULL OR on_behalf_of_membership_id <> decided_by_membership_id',
        [],
        'approval_decisions_behalf_check'
      )
    })
    // Um voto por aprovador elegível (o próprio ou quem delegou) em cada etapa.
    this.schema.raw(`CREATE UNIQUE INDEX approval_decisions_slot_unique ON approval_decisions
      (tenant_id, request_id, step_sequence, COALESCE(on_behalf_of_membership_id, decided_by_membership_id))`)
    this.schema.raw(`
      CREATE FUNCTION approval_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'APPROVAL_DECISIONS_APPEND_ONLY' USING ERRCODE = '23000'; END $$`)
    this.schema
      .raw(`CREATE TRIGGER approval_decisions_append_only BEFORE UPDATE OR DELETE ON approval_decisions
      FOR EACH ROW EXECUTE FUNCTION approval_decisions_append_only()`)
    this.schema.raw(`REVOKE UPDATE, DELETE, TRUNCATE ON approval_decisions FROM "${runtime}"`)

    createTenantTable(this, 'approval_delegations', (table) => {
      table.uuid('delegator_membership_id').notNullable()
      table.uuid('delegate_membership_id').notNullable()
      table.uuid('workflow_id').nullable()
      table.timestamp('starts_at', { useTz: true }).notNullable()
      table.timestamp('ends_at', { useTz: true }).notNullable()
      table.string('reason', 300).notNullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.timestamp('revoked_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'delegator_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'delegate_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'workflow_id', 'approval_workflows')
      table.index(
        ['tenant_id', 'delegate_membership_id', 'status'],
        'approval_delegations_delegate_index'
      )
      table.check(
        'delegator_membership_id <> delegate_membership_id',
        [],
        'approval_delegations_self_check'
      )
      table.check('ends_at > starts_at', [], 'approval_delegations_period_check')
      table.check("status IN ('ACTIVE', 'REVOKED')", [], 'approval_delegations_status_check')
    })
  }

  async down() {
    this.schema.dropTable('approval_delegations')
    this.schema.raw('DROP TRIGGER approval_decisions_append_only ON approval_decisions')
    this.schema.dropTable('approval_decisions')
    this.schema.raw('DROP FUNCTION approval_decisions_append_only()')
    this.schema.dropTable('approval_requests')
    this.schema.raw('DROP TRIGGER approval_steps_guard ON approval_workflow_steps')
    this.schema.dropTable('approval_workflow_steps')
    this.schema.raw('DROP FUNCTION approval_steps_guard()')
    this.schema.dropTable('approval_workflows')
  }
}
