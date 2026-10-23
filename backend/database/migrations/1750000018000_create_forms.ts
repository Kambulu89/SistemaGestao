import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Formulários (C11). O layout (secções e ligações a campos, por código) e as condições de apresentação são dados
 * declarativos validados pelo servidor — nunca código. Um formulário publicado é imutável: só pode passar a
 * RETIRED (trigger); uma alteração faz-se numa nova revisão. A publicação regista a revisão da entidade contra a
 * qual foi verificado. Os registos escrevem-se sempre na entidade (não há submissões redundantes).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'form_definitions', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('description', 500).nullable()
      table.integer('revision').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.jsonb('modes').notNullable()
      table.boolean('is_default').notNullable().defaultTo(false)
      table.jsonb('layout').notNullable()
      table.integer('schema_revision').nullable()
      table.timestamp('published_at', { useTz: true }).nullable()
      table.uuid('published_by_membership_id').nullable()
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'published_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'entity_definition_id', 'code', 'revision'], {
        indexName: 'form_definitions_revision_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE form_definitions
        ADD CONSTRAINT form_definitions_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
        ADD CONSTRAINT form_definitions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
        ADD CONSTRAINT form_definitions_revision_check CHECK (revision >= 1),
        ADD CONSTRAINT form_definitions_published_check
          CHECK ((status = 'DRAFT') = (published_at IS NULL) AND (status = 'DRAFT') = (schema_revision IS NULL)),
        ADD CONSTRAINT form_definitions_json_check
          CHECK (jsonb_typeof(modes) = 'array' AND jsonb_typeof(layout) = 'object')
    `)
    // No máximo um rascunho e uma revisão em vigor por formulário (também sob concorrência).
    this.schema.raw(`
      CREATE UNIQUE INDEX form_definitions_one_draft ON form_definitions
        (tenant_id, entity_definition_id, code) WHERE status = 'DRAFT'
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX form_definitions_one_published ON form_definitions
        (tenant_id, entity_definition_id, code) WHERE status = 'PUBLISHED'
    `)

    // Um formulário publicado só pode passar a RETIRED; o resto é imutável (nem SQL directo o altera).
    this.schema.raw(`
      CREATE FUNCTION form_definition_guard() RETURNS trigger
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
           AND (NEW.entity_definition_id, NEW.code, NEW.name, NEW.description, NEW.revision, NEW.modes,
                NEW.is_default, NEW.layout, NEW.schema_revision, NEW.published_at,
                NEW.published_by_membership_id, NEW.tenant_id)
              IS NOT DISTINCT FROM
              (OLD.entity_definition_id, OLD.code, OLD.name, OLD.description, OLD.revision, OLD.modes,
               OLD.is_default, OLD.layout, OLD.schema_revision, OLD.published_at,
               OLD.published_by_membership_id, OLD.tenant_id) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'PUBLISHED_FORM_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER form_definitions_guard BEFORE UPDATE OR DELETE ON form_definitions
        FOR EACH ROW EXECUTE FUNCTION form_definition_guard()
    `)

    auditTable(this, 'form_definitions')
  }

  async down() {
    dropTable(this, 'form_definitions')
    this.schema.raw(`DROP FUNCTION IF EXISTS form_definition_guard()`)
  }
}
