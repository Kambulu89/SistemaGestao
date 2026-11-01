import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Metadados e entidades dinâmicas (C10). Tudo de tenant, com RLS e auditoria. Versões publicadas e campos
 * são imutáveis (trigger, também para SQL directo); só a conta dona, com o interruptor de retenção da
 * auditoria (`app.audit_purge`), os apaga (limpeza de tenants de teste). Os valores dos registos
 * ficam em JSONB validado pela aplicação contra a versão exacta do esquema; nunca se criam tabelas ou
 * colunas por cliente. Os valores sensíveis vivem numa coluna à parte, redigida na auditoria.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'entity_definitions', (table) => {
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('description', 500).nullable()
      table.string('kind', 10).notNullable().defaultTo('DYNAMIC')
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.integer('published_version').nullable()
      table.string('ownership_mode', 10).notNullable().defaultTo('TENANT')
      table.unique(['tenant_id', 'code'])
    })
    this.schema.raw(`
      ALTER TABLE entity_definitions
        ADD CONSTRAINT entity_definitions_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
        ADD CONSTRAINT entity_definitions_kind_check CHECK (kind IN ('EXTENSION', 'DYNAMIC')),
        ADD CONSTRAINT entity_definitions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
        ADD CONSTRAINT entity_definitions_ownership_check CHECK (ownership_mode IN ('TENANT', 'UNIT', 'OWNER')),
        ADD CONSTRAINT entity_definitions_published_check
          CHECK (status <> 'PUBLISHED' OR published_version IS NOT NULL)
    `)

    createTenantTable(this, 'entity_schema_versions', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.integer('revision').notNullable()
      table.timestamp('published_at', { useTz: true }).nullable()
      table.uuid('published_by_membership_id').nullable()
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'published_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'entity_definition_id', 'revision'], {
        indexName: 'entity_schema_versions_revision_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE entity_schema_versions
        ADD CONSTRAINT entity_schema_versions_revision_check CHECK (revision >= 1)
    `)
    // No máximo um rascunho por entidade (também sob concorrência).
    this.schema.raw(`
      CREATE UNIQUE INDEX entity_schema_versions_one_draft ON entity_schema_versions
        (tenant_id, entity_definition_id) WHERE published_at IS NULL
    `)

    createTenantTable(this, 'field_definitions', (table) => {
      table.uuid('entity_schema_version_id').notNullable()
      table.string('code', 50).notNullable()
      table.string('label', 120).notNullable()
      table.string('field_type', 20).notNullable()
      table.boolean('required').notNullable().defaultTo(false)
      table.jsonb('default_value').nullable()
      table.jsonb('validation').notNullable().defaultTo('{}')
      table.jsonb('options').notNullable().defaultTo('[]')
      table.integer('position').notNullable()
      table.uuid('reference_entity_id').nullable()
      table.boolean('sensitive').notNullable().defaultTo(false)
      table.boolean('read_only').notNullable().defaultTo(false)
      table.boolean('archived').notNullable().defaultTo(false)
      tenantForeignKey(table, 'entity_schema_version_id', 'entity_schema_versions')
      tenantForeignKey(table, 'reference_entity_id', 'entity_definitions')
      table.unique(['tenant_id', 'entity_schema_version_id', 'code'], {
        indexName: 'field_definitions_code_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE field_definitions
        ADD CONSTRAINT field_definitions_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
        ADD CONSTRAINT field_definitions_type_check CHECK (field_type IN (
          'TEXT','TEXTAREA','NUMBER','DECIMAL','BOOLEAN','DATE','DATETIME','EMAIL','PHONE','URL',
          'SELECT','RADIO','MULTISELECT','ENTITY_REFERENCE','USER_REFERENCE')),
        ADD CONSTRAINT field_definitions_reference_check
          CHECK ((field_type = 'ENTITY_REFERENCE') = (reference_entity_id IS NOT NULL))
    `)

    createTenantTable(this, 'dynamic_records', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.uuid('schema_version_id').notNullable()
      table.uuid('owner_membership_id').nullable()
      table.uuid('organization_unit_id').nullable()
      table.jsonb('data').notNullable().defaultTo('{}')
      table.jsonb('sensitive_data').notNullable().defaultTo('{}')
      table.text('search_text').notNullable().defaultTo('')
      table.timestamp('archived_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'schema_version_id', 'entity_schema_versions')
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'organization_unit_id', 'organization_units')
      table.index(
        ['tenant_id', 'entity_definition_id', 'created_at'],
        'dynamic_records_entity_index'
      )
    })
    this.schema.raw(`
      ALTER TABLE dynamic_records
        ADD CONSTRAINT dynamic_records_data_check
          CHECK (jsonb_typeof(data) = 'object' AND jsonb_typeof(sensitive_data) = 'object')
    `)

    // Índice de valores únicos mantido na mesma transacção do registo: a unicidade é garantida pela base
    // (não por uma consulta prévia), por isso dois pedidos concorrentes com o mesmo valor não passam.
    createTenantTable(this, 'dynamic_unique_values', (table) => {
      table.uuid('entity_definition_id').notNullable()
      table.string('field_code', 50).notNullable()
      table.string('value_key', 300).notNullable()
      table.uuid('record_id').notNullable()
      tenantForeignKey(table, 'entity_definition_id', 'entity_definitions')
      tenantForeignKey(table, 'record_id', 'dynamic_records', { onDelete: 'CASCADE' })
      table.unique(['tenant_id', 'entity_definition_id', 'field_code', 'value_key'], {
        indexName: 'dynamic_unique_values_unique',
      })
      table.index(['tenant_id', 'record_id'], 'dynamic_unique_values_record_index')
    })

    // Versões publicadas e os seus campos são imutáveis: nem a aplicação nem SQL directo os alteram.
    this.schema.raw(`
      CREATE FUNCTION entity_schema_version_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.published_at IS NOT NULL THEN
          IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER entity_schema_versions_guard BEFORE UPDATE OR DELETE ON entity_schema_versions
        FOR EACH ROW EXECUTE FUNCTION entity_schema_version_guard()
    `)
    this.schema.raw(`
      CREATE FUNCTION field_definition_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE version_id uuid;
      BEGIN
        IF TG_OP = 'INSERT' THEN version_id := NEW.entity_schema_version_id;
        ELSE version_id := OLD.entity_schema_version_id; END IF;
        IF EXISTS (SELECT 1 FROM entity_schema_versions v WHERE v.id = version_id AND v.published_at IS NOT NULL) THEN
          IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER field_definitions_guard BEFORE INSERT OR UPDATE OR DELETE ON field_definitions
        FOR EACH ROW EXECUTE FUNCTION field_definition_guard()
    `)

    for (const table of [
      'entity_definitions',
      'entity_schema_versions',
      'field_definitions',
      'dynamic_unique_values',
    ]) {
      auditTable(this, table)
    }
    auditTable(this, 'dynamic_records', ['sensitive_data', 'search_text'])
  }

  async down() {
    dropTable(this, 'dynamic_unique_values')
    dropTable(this, 'dynamic_records')
    dropTable(this, 'field_definitions')
    dropTable(this, 'entity_schema_versions')
    dropTable(this, 'entity_definitions')
    this.schema.raw(`DROP FUNCTION IF EXISTS field_definition_guard()`)
    this.schema.raw(`DROP FUNCTION IF EXISTS entity_schema_version_guard()`)
  }
}
