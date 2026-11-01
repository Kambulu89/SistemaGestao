import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Workflows de aprovação (C14). A definição (etapas, responsáveis, critérios ALL/ANY/QUORUM, condições AST) vive em JSON
 * validado pelo servidor e é imutável depois de publicada. Cada submissão congela o registo (`submitted_snapshot`,
 * `resource_version`) e a definição usada; as tarefas são decididas uma única vez (trigger: o estado terminal não muda) e
 * as delegações são directas e limitadas no tempo, no âmbito e no montante.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'workflow_definitions', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('description', 500).nullable()
      table.integer('revision').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.jsonb('graph').notNullable()
      table.timestamp('published_at', { useTz: true }).nullable()
      table.uuid('published_by_membership_id').nullable()
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'published_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'entity_definition_id', 'code', 'revision'], {
        indexName: 'workflow_definitions_revision_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE workflow_definitions
        ADD CONSTRAINT workflow_definitions_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
        ADD CONSTRAINT workflow_definitions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
        ADD CONSTRAINT workflow_definitions_revision_check CHECK (revision >= 1),
        ADD CONSTRAINT workflow_definitions_published_check CHECK ((status = 'DRAFT') = (published_at IS NULL)),
        ADD CONSTRAINT workflow_definitions_graph_check CHECK (jsonb_typeof(graph) = 'object')
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX workflow_definitions_one_draft ON workflow_definitions
        (tenant_id, entity_definition_id, code) WHERE status = 'DRAFT'
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX workflow_definitions_one_published ON workflow_definitions
        (tenant_id, entity_definition_id, code) WHERE status = 'PUBLISHED'
    `)

    createTenantTable(this, 'workflow_instances', (table) => {
      table.uuid('workflow_definition_id').notNullable()
      table.uuid('entity_definition_id').notNullable()
      table.uuid('record_id').notNullable()
      table.integer('resource_version').notNullable()
      table.jsonb('submitted_snapshot').notNullable()
      table.string('status', 10).notNullable().defaultTo('WAITING')
      table.string('end_reason', 30).nullable()
      table.integer('current_stage_index').notNullable().defaultTo(0)
      table.uuid('submitted_by_membership_id').notNullable()
      table.string('correlation_id', 100).nullable()
      table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('ended_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'workflow_definition_id', 'workflow_definitions')
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'record_id', 'dynamic_records')
      tenantForeignKey(table, 'submitted_by_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'record_id', 'started_at'], 'workflow_instances_record_index')
      table.index(['tenant_id', 'submitted_by_membership_id'], 'workflow_instances_submitter_index')
    })
    this.schema.raw(`
      ALTER TABLE workflow_instances
        ADD CONSTRAINT workflow_instances_status_check
          CHECK (status IN ('RUNNING', 'WAITING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED')),
        ADD CONSTRAINT workflow_instances_ended_check
          CHECK ((status IN ('RUNNING', 'WAITING')) = (ended_at IS NULL)),
        ADD CONSTRAINT workflow_instances_snapshot_check CHECK (jsonb_typeof(submitted_snapshot) = 'object'),
        ADD CONSTRAINT workflow_instances_resource_version_check CHECK (resource_version >= 1)
    `)
    // Um registo só tem um processo de aprovação em curso de cada vez.
    this.schema.raw(`
      CREATE UNIQUE INDEX workflow_instances_one_active ON workflow_instances (tenant_id, record_id)
        WHERE status IN ('RUNNING', 'WAITING')
    `)

    createTenantTable(this, 'workflow_tasks', (table) => {
      table.uuid('instance_id').notNullable()
      table.string('stage_code', 50).notNullable()
      table.integer('stage_index').notNullable()
      table.uuid('assignee_membership_id').nullable()
      table.uuid('candidate_role_id').nullable()
      table.string('status', 10).notNullable().defaultTo('OPEN')
      table.timestamp('due_at', { useTz: true }).nullable()
      table.timestamp('claimed_at', { useTz: true }).nullable()
      table.uuid('claimed_by_membership_id').nullable()
      table.uuid('decided_by_membership_id').nullable()
      table.uuid('via_delegation_id').nullable()
      table.text('decision_reason').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'instance_id', 'workflow_instances')
      tenantForeignKey(table, 'assignee_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'candidate_role_id', 'roles')
      tenantForeignKey(table, 'claimed_by_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'instance_id', 'stage_index'], 'workflow_tasks_instance_index')
      table.index(
        ['tenant_id', 'assignee_membership_id', 'status'],
        'workflow_tasks_assignee_index'
      )
      table.index(['tenant_id', 'candidate_role_id', 'status'], 'workflow_tasks_role_index')
    })
    this.schema.raw(`
      ALTER TABLE workflow_tasks
        ADD CONSTRAINT workflow_tasks_status_check
          CHECK (status IN ('OPEN', 'CLAIMED', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED')),
        ADD CONSTRAINT workflow_tasks_responsible_check
          CHECK ((assignee_membership_id IS NULL) <> (candidate_role_id IS NULL)),
        ADD CONSTRAINT workflow_tasks_decided_check
          CHECK ((status IN ('APPROVED', 'REJECTED', 'RETURNED')) = (decided_at IS NOT NULL))
    `)

    createTenantTable(this, 'approval_delegations', (table) => {
      table.uuid('from_membership_id').notNullable()
      table.uuid('to_membership_id').notNullable()
      table.timestamp('valid_from', { useTz: true }).notNullable()
      table.timestamp('valid_until', { useTz: true }).notNullable()
      table.jsonb('scope').notNullable()
      table.decimal('max_amount', 19, 4).nullable()
      table.string('currency', 3).nullable()
      table.string('reason', 500).notNullable()
      table.timestamp('revoked_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'from_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'to_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'to_membership_id'], 'approval_delegations_to_index')
      table.index(['tenant_id', 'from_membership_id'], 'approval_delegations_from_index')
    })
    this.schema.raw(`
      ALTER TABLE approval_delegations
        ADD CONSTRAINT approval_delegations_distinct_check CHECK (from_membership_id <> to_membership_id),
        ADD CONSTRAINT approval_delegations_period_check CHECK (valid_until > valid_from),
        ADD CONSTRAINT approval_delegations_scope_check CHECK (jsonb_typeof(scope) = 'object'),
        ADD CONSTRAINT approval_delegations_amount_check
          CHECK (max_amount IS NULL OR (max_amount >= 0 AND currency IS NOT NULL))
    `)

    // Uma definição publicada só pode passar a RETIRED; o resto é imutável (nem SQL directo o altera).
    this.schema.raw(`
      CREATE FUNCTION workflow_definition_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.status = 'DRAFT' THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
           AND (NEW.entity_definition_id, NEW.code, NEW.name, NEW.description, NEW.revision, NEW.graph,
                NEW.published_at, NEW.published_by_membership_id, NEW.tenant_id)
              IS NOT DISTINCT FROM
              (OLD.entity_definition_id, OLD.code, OLD.name, OLD.description, OLD.revision, OLD.graph,
               OLD.published_at, OLD.published_by_membership_id, OLD.tenant_id) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'PUBLISHED_WORKFLOW_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER workflow_definitions_guard BEFORE UPDATE OR DELETE ON workflow_definitions
        FOR EACH ROW EXECUTE FUNCTION workflow_definition_guard()
    `)
    // Instâncias e tarefas terminadas não mudam: uma decisão só se toma uma vez (nem SQL directo a desfaz).
    this.schema.raw(`
      CREATE FUNCTION workflow_terminal_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.status IN ('APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'FAILED') THEN
          IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'WORKFLOW_TERMINAL_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER workflow_instances_guard BEFORE UPDATE OR DELETE ON workflow_instances
        FOR EACH ROW EXECUTE FUNCTION workflow_terminal_guard()
    `)
    this.schema.raw(`
      CREATE TRIGGER workflow_tasks_guard BEFORE UPDATE OR DELETE ON workflow_tasks
        FOR EACH ROW EXECUTE FUNCTION workflow_terminal_guard()
    `)

    auditTable(this, 'workflow_definitions')
    auditTable(this, 'workflow_instances', ['submitted_snapshot'])
    auditTable(this, 'workflow_tasks')
    auditTable(this, 'approval_delegations')
  }

  async down() {
    dropTable(this, 'approval_delegations')
    dropTable(this, 'workflow_tasks')
    dropTable(this, 'workflow_instances')
    dropTable(this, 'workflow_definitions')
    this.schema.raw(`DROP FUNCTION IF EXISTS workflow_terminal_guard()`)
    this.schema.raw(`DROP FUNCTION IF EXISTS workflow_definition_guard()`)
  }
}
