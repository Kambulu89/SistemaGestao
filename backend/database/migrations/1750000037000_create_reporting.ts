import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Relatórios, painéis, exportações e pesquisa (S04). Um **relatório** é uma consulta declarativa sobre um dataset
 * registado em código (campos, filtros, agrupamento e medidas: nunca SQL livre). Publicado, deixa de mudar. Um
 * **painel** junta widgets que apontam para relatórios publicados. Uma **exportação** é um trabalho assíncrono que
 * revalida os direitos ao executar e ao descarregar. O **índice de pesquisa** é um read model derivado e reconstruível.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'report_definitions', (table) => {
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('dataset_code', 50).notNullable()
      table.jsonb('selected_fields').notNullable().defaultTo('[]')
      table.jsonb('filters_schema').notNullable().defaultTo('[]')
      table.jsonb('grouping').notNullable().defaultTo('[]')
      table.jsonb('measures').notNullable().defaultTo('[]')
      table.jsonb('sort').notNullable().defaultTo('[]')
      table.string('visibility', 10).notNullable().defaultTo('PRIVATE')
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.uuid('owner_membership_id').notNullable()
      table.timestamp('published_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'code'], { indexName: 'report_definitions_code_unique' })
      table.index(['tenant_id', 'status'], 'report_definitions_status_index')
    })
    this.schema.raw(`
      ALTER TABLE report_definitions
        ADD CONSTRAINT report_definitions_visibility_check CHECK (visibility IN ('PRIVATE', 'TENANT')),
        ADD CONSTRAINT report_definitions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED')),
        ADD CONSTRAINT report_definitions_published_check
          CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL))
    `)
    // Um relatório publicado não muda nem se apaga: quem precisa de outro duplica-o.
    this.schema.raw(`
      CREATE FUNCTION report_definitions_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF OLD.status = 'PUBLISHED' THEN
          RAISE EXCEPTION 'REPORT_PUBLISHED_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER report_definitions_guard BEFORE UPDATE OR DELETE ON report_definitions
        FOR EACH ROW EXECUTE FUNCTION report_definitions_guard()
    `)

    createTenantTable(this, 'dashboards', (table) => {
      table.string('name', 160).notNullable()
      table.uuid('owner_membership_id').notNullable()
      table.string('visibility', 10).notNullable().defaultTo('PRIVATE')
      table.jsonb('filters').notNullable().defaultTo('[]')
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'visibility'], 'dashboards_visibility_index')
    })
    this.schema.raw(`
      ALTER TABLE dashboards
        ADD CONSTRAINT dashboards_visibility_check CHECK (visibility IN ('PRIVATE', 'TENANT'))
    `)

    createTenantTable(this, 'dashboard_widgets', (table) => {
      table.uuid('dashboard_id').notNullable()
      table.uuid('report_id').notNullable()
      table.string('title', 160).notNullable()
      table.string('type', 10).notNullable()
      table.jsonb('layout').notNullable().defaultTo('{}')
      table.jsonb('filters').notNullable().defaultTo('[]')
      table.integer('refresh_seconds').notNullable().defaultTo(300)
      table.integer('position').notNullable().defaultTo(0)
      tenantForeignKey(table, 'dashboard_id', 'dashboards')
      tenantForeignKey(table, 'report_id', 'report_definitions')
      table.index(['tenant_id', 'dashboard_id', 'position'], 'dashboard_widgets_dashboard_index')
    })
    this.schema.raw(`
      ALTER TABLE dashboard_widgets
        ADD CONSTRAINT dashboard_widgets_type_check CHECK (type IN ('KPI', 'TABLE', 'BAR', 'LINE', 'PIE')),
        ADD CONSTRAINT dashboard_widgets_refresh_check CHECK (refresh_seconds >= 30)
    `)

    createTenantTable(this, 'export_jobs', (table) => {
      table.uuid('report_id').notNullable()
      table.uuid('requested_by_membership_id').notNullable()
      table.jsonb('filters_snapshot').notNullable().defaultTo('[]')
      table.string('format', 4).notNullable()
      table.string('status', 8).notNullable().defaultTo('QUEUED')
      table.uuid('attachment_id').nullable()
      table.jsonb('columns').nullable()
      table.timestamp('expires_at', { useTz: true }).nullable()
      table.integer('row_count').nullable()
      table.string('error_code', 60).nullable()
      table.string('error_message', 300).nullable()
      table.timestamp('started_at', { useTz: true }).nullable()
      table.timestamp('finished_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'report_id', 'report_definitions')
      tenantForeignKey(table, 'requested_by_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'attachment_id', 'attachments')
      table.index(['tenant_id', 'status', 'created_at'], 'export_jobs_queue_index')
      table.index(['tenant_id', 'requested_by_membership_id'], 'export_jobs_owner_index')
    })
    this.schema.raw(`
      ALTER TABLE export_jobs
        ADD CONSTRAINT export_jobs_format_check CHECK (format IN ('CSV', 'XLSX', 'PDF')),
        ADD CONSTRAINT export_jobs_status_check
          CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
        ADD CONSTRAINT export_jobs_ready_check
          CHECK (status <> 'READY' OR (attachment_id IS NOT NULL AND expires_at IS NOT NULL AND row_count IS NOT NULL))
    `)

    createTenantTable(this, 'search_documents', (table) => {
      table.string('resource_type', 40).notNullable()
      table.uuid('resource_id').notNullable()
      table.string('title', 300).notNullable()
      table.text('searchable_text').notNullable()
      table.uuid('unit_id').nullable()
      table.uuid('owner_membership_id').nullable()
      table.integer('indexed_version').notNullable().defaultTo(1)
      table.timestamp('indexed_at', { useTz: true }).notNullable().defaultTo(this.now())
      tenantForeignKey(table, 'unit_id', 'organization_units')
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'resource_type', 'resource_id'], {
        indexName: 'search_documents_resource_unique',
      })
      table.index(['tenant_id', 'resource_type'], 'search_documents_type_index')
    })
    this.schema.raw(`
      CREATE INDEX search_documents_text_index
        ON search_documents USING gin (to_tsvector('simple', searchable_text))
    `)

    for (const table of [
      'report_definitions',
      'dashboards',
      'dashboard_widgets',
      'export_jobs',
      'search_documents',
    ]) {
      // O texto indexado pode conter dados pessoais: não entra em claro na auditoria.
      auditTable(this, table, table === 'search_documents' ? ['title', 'searchable_text'] : [])
    }
  }

  async down() {
    for (const table of [
      'search_documents',
      'export_jobs',
      'dashboard_widgets',
      'dashboards',
      'report_definitions',
    ]) {
      dropTable(this, table)
    }
    this.schema.raw(`DROP FUNCTION IF EXISTS report_definitions_guard()`)
  }
}
