import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Máquinas de estados (C13). Os estados e as transições (com guarda declarativa, nunca código) vivem em JSON validado
 * pelo servidor; a máquina publicada é imutável (trigger: só passa a RETIRED). O estado de cada registo guarda-se à parte
 * (`record_states`), por isso o módulo não escreve nas tabelas dos registos; cada transição escreve o estado, o histórico
 * (`state_history`, só de acrescentar) e o evento (`outbox_events`) na mesma transacção.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'state_machines', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('description', 500).nullable()
      table.integer('revision').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.jsonb('states').notNullable()
      table.jsonb('transitions').notNullable()
      table.timestamp('published_at', { useTz: true }).nullable()
      table.uuid('published_by_membership_id').nullable()
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'published_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'entity_definition_id', 'code', 'revision'], {
        indexName: 'state_machines_revision_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE state_machines
        ADD CONSTRAINT state_machines_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
        ADD CONSTRAINT state_machines_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
        ADD CONSTRAINT state_machines_revision_check CHECK (revision >= 1),
        ADD CONSTRAINT state_machines_published_check CHECK ((status = 'DRAFT') = (published_at IS NULL)),
        ADD CONSTRAINT state_machines_json_check
          CHECK (jsonb_typeof(states) = 'array' AND jsonb_typeof(transitions) = 'array')
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX state_machines_one_draft ON state_machines
        (tenant_id, entity_definition_id, code) WHERE status = 'DRAFT'
    `)
    // Uma só máquina em vigor por entidade (e, portanto, por código).
    this.schema.raw(`
      CREATE UNIQUE INDEX state_machines_one_per_entity ON state_machines
        (tenant_id, entity_definition_id) WHERE status = 'PUBLISHED'
    `)

    createTenantTable(this, 'record_states', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.uuid('record_id').notNullable()
      table.uuid('state_machine_id').notNullable()
      table.string('state_code', 50).notNullable()
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'record_id', 'dynamic_records')
      tenantForeignKey(table, 'state_machine_id', 'state_machines')
      table.unique(['tenant_id', 'record_id'], { indexName: 'record_states_record_unique' })
      table.index(['tenant_id', 'entity_definition_id', 'state_code'], 'record_states_state_index')
    })

    createTenantTable(this, 'state_history', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.uuid('record_id').notNullable()
      table.uuid('state_machine_id').notNullable()
      table.string('transition_code', 50).nullable()
      table.string('from_state', 50).nullable()
      table.string('to_state', 50).notNullable()
      table.uuid('actor_membership_id').nullable()
      table.text('reason').nullable()
      table.string('correlation_id', 100).nullable()
      table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(this.now())
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'record_id', 'dynamic_records')
      tenantForeignKey(table, 'state_machine_id', 'state_machines')
      tenantForeignKey(table, 'actor_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'record_id', 'occurred_at'], 'state_history_record_index')
    })

    // Uma máquina publicada só pode passar a RETIRED; o resto é imutável (nem SQL directo o altera).
    this.schema.raw(`
      CREATE FUNCTION state_machine_guard() RETURNS trigger
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
           AND (NEW.entity_definition_id, NEW.code, NEW.name, NEW.description, NEW.revision, NEW.states,
                NEW.transitions, NEW.published_at, NEW.published_by_membership_id, NEW.tenant_id)
              IS NOT DISTINCT FROM
              (OLD.entity_definition_id, OLD.code, OLD.name, OLD.description, OLD.revision, OLD.states,
               OLD.transitions, OLD.published_at, OLD.published_by_membership_id, OLD.tenant_id) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'PUBLISHED_STATE_MACHINE_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER state_machines_guard BEFORE UPDATE OR DELETE ON state_machines
        FOR EACH ROW EXECUTE FUNCTION state_machine_guard()
    `)
    // O histórico só se acrescenta (a conta dona, com o interruptor de retenção, pode limpar).
    this.schema.raw(`
      CREATE TRIGGER state_history_append_only BEFORE UPDATE OR DELETE ON state_history
        FOR EACH ROW EXECUTE FUNCTION audit_forbid_change()
    `)

    auditTable(this, 'state_machines')
    auditTable(this, 'record_states')
  }

  async down() {
    dropTable(this, 'state_history')
    dropTable(this, 'record_states')
    dropTable(this, 'state_machines')
    this.schema.raw(`DROP FUNCTION IF EXISTS state_machine_guard()`)
  }
}
