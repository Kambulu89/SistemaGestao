import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Regras (C12). A condição e a acção são AST declarativas (nunca código): a condição usa a mesma gramática das
 * políticas ABAC e a acção é um bloqueio com mensagem de negócio. Uma regra publicada é imutável: só pode passar
 * a DISABLED (trigger); uma alteração faz-se numa nova revisão. As avaliações recusadas ou com erro ficam em
 * `rule_evaluations` (só acrescenta; guarda o resumo dos dados, nunca os valores).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'rule_definitions', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('description', 500).nullable()
      table.string('trigger', 15).notNullable().defaultTo('VALIDATE')
      table.integer('revision').notNullable()
      table.integer('priority').notNullable().defaultTo(100)
      table.jsonb('condition_ast').notNullable()
      table.jsonb('action_ast').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.timestamp('effective_from', { useTz: true }).nullable()
      table.timestamp('effective_to', { useTz: true }).nullable()
      table.timestamp('published_at', { useTz: true }).nullable()
      table.uuid('published_by_membership_id').nullable()
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'published_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'entity_definition_id', 'code', 'revision'], {
        indexName: 'rule_definitions_revision_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE rule_definitions
        ADD CONSTRAINT rule_definitions_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
        ADD CONSTRAINT rule_definitions_trigger_check CHECK (trigger IN ('VALIDATE')),
        ADD CONSTRAINT rule_definitions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'DISABLED')),
        ADD CONSTRAINT rule_definitions_priority_check CHECK (priority BETWEEN 0 AND 1000),
        ADD CONSTRAINT rule_definitions_revision_check CHECK (revision >= 1),
        ADD CONSTRAINT rule_definitions_period_check
          CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
        ADD CONSTRAINT rule_definitions_published_check
          CHECK ((status = 'DRAFT') = (published_at IS NULL)),
        ADD CONSTRAINT rule_definitions_ast_check
          CHECK (jsonb_typeof(condition_ast) = 'object' AND jsonb_typeof(action_ast) = 'object')
    `)
    // No máximo um rascunho e uma revisão em vigor por regra (também sob concorrência).
    this.schema.raw(`
      CREATE UNIQUE INDEX rule_definitions_one_draft ON rule_definitions
        (tenant_id, entity_definition_id, code) WHERE status = 'DRAFT'
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX rule_definitions_one_published ON rule_definitions
        (tenant_id, entity_definition_id, code) WHERE status = 'PUBLISHED'
    `)
    this.schema.raw(`
      CREATE INDEX rule_definitions_published_index ON rule_definitions
        (tenant_id, entity_definition_id, trigger) WHERE status = 'PUBLISHED'
    `)

    createTenantTable(this, 'rule_evaluations', (table) => {
      table.uuid('rule_definition_id').notNullable()
      table.uuid('resource_id').nullable()
      table.string('correlation_id', 100).nullable()
      table.string('input_hash', 64).notNullable()
      table.string('result', 10).notNullable()
      table.integer('duration_ms').notNullable().defaultTo(0)
      table.string('error_code', 60).nullable()
      tenantForeignKey(table, 'rule_definition_id', 'rule_definitions')
      table.index(['tenant_id', 'rule_definition_id', 'created_at'], 'rule_evaluations_rule_index')
    })
    this.schema.raw(`
      ALTER TABLE rule_evaluations
        ADD CONSTRAINT rule_evaluations_result_check CHECK (result IN ('PASS', 'FAIL', 'SKIPPED', 'ERROR'))
    `)

    // Uma regra publicada só pode passar a DISABLED; o resto é imutável (nem SQL directo o altera).
    this.schema.raw(`
      CREATE FUNCTION rule_definition_guard() RETURNS trigger
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
        IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' AND NEW.status = 'DISABLED'
           AND (NEW.entity_definition_id, NEW.code, NEW.name, NEW.description, NEW.trigger, NEW.revision,
                NEW.priority, NEW.condition_ast, NEW.action_ast, NEW.effective_from, NEW.effective_to,
                NEW.published_at, NEW.published_by_membership_id, NEW.tenant_id)
              IS NOT DISTINCT FROM
              (OLD.entity_definition_id, OLD.code, OLD.name, OLD.description, OLD.trigger, OLD.revision,
               OLD.priority, OLD.condition_ast, OLD.action_ast, OLD.effective_from, OLD.effective_to,
               OLD.published_at, OLD.published_by_membership_id, OLD.tenant_id) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'PUBLISHED_RULE_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER rule_definitions_guard BEFORE UPDATE OR DELETE ON rule_definitions
        FOR EACH ROW EXECUTE FUNCTION rule_definition_guard()
    `)
    // As avaliações só se acrescentam (a conta dona, com o interruptor de retenção, pode limpar).
    this.schema.raw(`
      CREATE TRIGGER rule_evaluations_append_only BEFORE UPDATE OR DELETE ON rule_evaluations
        FOR EACH ROW EXECUTE FUNCTION audit_forbid_change()
    `)

    auditTable(this, 'rule_definitions')
  }

  async down() {
    dropTable(this, 'rule_evaluations')
    dropTable(this, 'rule_definitions')
    this.schema.raw(`DROP FUNCTION IF EXISTS rule_definition_guard()`)
  }
}
