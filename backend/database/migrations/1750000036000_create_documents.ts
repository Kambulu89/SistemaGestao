import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Documentos, anexos e modelos (S01). O **anexo** é o ficheiro: a chave de armazenamento é gerada pelo servidor e só
 * `AVAILABLE` se descarrega. O **documento** agrupa **versões** imutáveis que apontam para anexos. Um **modelo** tem
 * versões que, publicadas, deixam de mudar; gerar um documento guarda a versão do modelo e os valores usados, por isso
 * mudar o modelo depois nunca altera o que já foi emitido.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'attachments', (table) => {
      table.string('storage_key', 512).notNullable()
      table.string('original_name', 255).notNullable()
      table.string('mime_type', 100).notNullable()
      // Tamanho e SHA-256 declarados no pedido de upload; `received_*` é o que o servidor realmente guardou.
      table.bigInteger('size_bytes').notNullable()
      table.string('checksum', 64).notNullable()
      table.bigInteger('received_size').nullable()
      table.string('received_checksum', 64).nullable()
      table.string('status', 12).notNullable().defaultTo('PENDING')
      table.string('source', 10).notNullable().defaultTo('UPLOAD')
      table.string('reject_code', 40).nullable()
      table.uuid('uploaded_by_membership_id').notNullable()
      table.timestamp('upload_expires_at', { useTz: true }).nullable()
      table.timestamp('scanned_at', { useTz: true }).nullable()
      table.string('scan_signature', 80).nullable()
      table.timestamp('deleted_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'uploaded_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'storage_key'], { indexName: 'attachments_storage_key_unique' })
      table.index(['tenant_id', 'status'], 'attachments_status_index')
    })
    this.schema.raw(`
      ALTER TABLE attachments
        ADD CONSTRAINT attachments_status_check
          CHECK (status IN ('PENDING', 'QUARANTINED', 'AVAILABLE', 'REJECTED', 'DELETED')),
        ADD CONSTRAINT attachments_source_check CHECK (source IN ('UPLOAD', 'GENERATED')),
        ADD CONSTRAINT attachments_size_check CHECK (size_bytes > 0),
        ADD CONSTRAINT attachments_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$')
    `)

    createTenantTable(this, 'documents', (table) => {
      table.string('title', 200).notNullable()
      table.string('category_code', 50).notNullable().defaultTo('general')
      table.uuid('owner_membership_id').notNullable()
      table.string('visibility', 10).notNullable().defaultTo('PRIVATE')
      table.string('resource_type', 40).nullable()
      table.uuid('resource_id').nullable()
      table.uuid('current_version_id').nullable()
      table.date('retention_until').nullable()
      table.boolean('legal_hold').notNullable().defaultTo(false)
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.timestamp('deleted_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'status', 'category_code'], 'documents_library_index')
      table.index(['tenant_id', 'resource_type', 'resource_id'], 'documents_resource_index')
    })
    this.schema.raw(`
      ALTER TABLE documents
        ADD CONSTRAINT documents_visibility_check CHECK (visibility IN ('PRIVATE', 'TENANT', 'RESOURCE')),
        ADD CONSTRAINT documents_status_check CHECK (status IN ('ACTIVE', 'DELETED')),
        ADD CONSTRAINT documents_resource_check
          CHECK ((resource_type IS NULL) = (resource_id IS NULL)),
        ADD CONSTRAINT documents_resource_visibility_check
          CHECK (visibility <> 'RESOURCE' OR resource_type IS NOT NULL)
    `)

    createTenantTable(this, 'templates', (table) => {
      table.string('code', 60).notNullable()
      table.string('name', 150).notNullable()
      table.string('channel', 10).notNullable()
      table.string('resource_type', 40).nullable()
      table.unique(['tenant_id', 'code'], { indexName: 'templates_code_unique' })
    })
    this.schema.raw(`
      ALTER TABLE templates
        ADD CONSTRAINT templates_channel_check
          CHECK (channel IN ('DOCUMENT', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH'))
    `)

    createTenantTable(this, 'template_versions', (table) => {
      table.uuid('template_id').notNullable()
      table.integer('revision').notNullable()
      table.text('body').notNullable()
      table.jsonb('variable_schema').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('locale', 10).notNullable().defaultTo('pt-AO')
      table.timestamp('published_at', { useTz: true }).nullable()
      table.uuid('published_by_membership_id').nullable()
      tenantForeignKey(table, 'template_id', 'templates')
      tenantForeignKey(table, 'published_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'template_id', 'revision'], {
        indexName: 'template_versions_revision_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE template_versions
        ADD CONSTRAINT template_versions_status_check
          CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
        ADD CONSTRAINT template_versions_revision_check CHECK (revision >= 1)
    `)
    // No máximo uma versão publicada por modelo e língua.
    this.schema.raw(`
      CREATE UNIQUE INDEX template_versions_one_published
        ON template_versions (tenant_id, template_id, locale) WHERE status = 'PUBLISHED'
    `)

    createTenantTable(this, 'document_versions', (table) => {
      table.uuid('document_id').notNullable()
      table.integer('revision').notNullable()
      table.uuid('attachment_id').notNullable()
      table.text('change_note').nullable()
      // Geração a partir de um modelo: a versão usada e os valores ficam como instantâneo.
      table.uuid('template_version_id').nullable()
      table.jsonb('generated_values').nullable()
      tenantForeignKey(table, 'document_id', 'documents')
      tenantForeignKey(table, 'attachment_id', 'attachments')
      tenantForeignKey(table, 'template_version_id', 'template_versions')
      table.unique(['tenant_id', 'document_id', 'revision'], {
        indexName: 'document_versions_revision_unique',
      })
      table.unique(['tenant_id', 'attachment_id'], {
        indexName: 'document_versions_attachment_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE document_versions ADD CONSTRAINT document_versions_revision_check CHECK (revision >= 1)
    `)
    this.schema.raw(`
      ALTER TABLE documents
        ADD CONSTRAINT documents_current_version_fk FOREIGN KEY (tenant_id, current_version_id)
          REFERENCES document_versions (tenant_id, id)
    `)

    createTenantTable(this, 'resource_attachments', (table) => {
      table.string('resource_type', 40).notNullable()
      table.uuid('resource_id').notNullable()
      table.uuid('attachment_id').notNullable()
      table.string('category', 50).nullable()
      tenantForeignKey(table, 'attachment_id', 'attachments')
      table.unique(['tenant_id', 'resource_type', 'resource_id', 'attachment_id'], {
        indexName: 'resource_attachments_unique',
      })
      table.index(['tenant_id', 'resource_type', 'resource_id'], 'resource_attachments_resource')
    })

    // --- imutabilidade -------------------------------------------------------------------------------
    this.schema.raw(`
      CREATE FUNCTION documents_append_only() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'DOCUMENT_VERSION_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER document_versions_append_only BEFORE UPDATE OR DELETE ON document_versions
        FOR EACH ROW EXECUTE FUNCTION documents_append_only()
    `)

    // Uma versão publicada de um modelo nunca muda: só pode passar a retirada. Rascunhos editam-se e apagam-se.
    this.schema.raw(`
      CREATE FUNCTION template_versions_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF OLD.status <> 'DRAFT' THEN
            RAISE EXCEPTION 'TEMPLATE_VERSION_IMMUTABLE' USING ERRCODE = '23000';
          END IF;
          RETURN OLD;
        END IF;
        IF OLD.status = 'DRAFT' THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
           AND (NEW.template_id, NEW.revision, NEW.body, NEW.variable_schema, NEW.locale, NEW.published_at)
               IS NOT DISTINCT FROM
               (OLD.template_id, OLD.revision, OLD.body, OLD.variable_schema, OLD.locale, OLD.published_at) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'TEMPLATE_VERSION_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER template_versions_guard BEFORE UPDATE OR DELETE ON template_versions
        FOR EACH ROW EXECUTE FUNCTION template_versions_guard()
    `)

    // O conteúdo de um anexo disponível não muda: só pode ser apagado (o ficheiro sai do armazenamento).
    this.schema.raw(`
      CREATE FUNCTION attachments_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('REJECTED', 'DELETED') THEN
          RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('AVAILABLE', 'QUARANTINED') AND
           (NEW.storage_key, NEW.size_bytes, NEW.checksum, NEW.mime_type, NEW.original_name, NEW.source)
             IS DISTINCT FROM
           (OLD.storage_key, OLD.size_bytes, OLD.checksum, OLD.mime_type, OLD.original_name, OLD.source) THEN
          RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'AVAILABLE' AND NEW.status NOT IN ('AVAILABLE', 'DELETED') THEN
          RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER attachments_guard BEFORE UPDATE OR DELETE ON attachments
        FOR EACH ROW EXECUTE FUNCTION attachments_guard()
    `)

    // Retenção e retenção legal: um documento em retenção não se apaga, nem pela API nem por SQL.
    this.schema.raw(`
      CREATE FUNCTION documents_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'DOCUMENT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF NEW.status = 'DELETED' AND OLD.status <> 'DELETED'
           AND (OLD.legal_hold OR (OLD.retention_until IS NOT NULL AND OLD.retention_until > current_date)) THEN
          RAISE EXCEPTION 'DOCUMENT_RETENTION' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DELETED' THEN
          RAISE EXCEPTION 'DOCUMENT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER documents_guard BEFORE UPDATE OR DELETE ON documents
        FOR EACH ROW EXECUTE FUNCTION documents_guard()
    `)

    for (const table of [
      'attachments',
      'documents',
      'document_versions',
      'templates',
      'template_versions',
      'resource_attachments',
    ]) {
      // Nomes de ficheiro e o corpo dos modelos podem ter dados pessoais: não entram em claro na auditoria.
      const redact =
        table === 'attachments'
          ? ['original_name', 'storage_key']
          : table === 'template_versions'
            ? ['body']
            : table === 'document_versions'
              ? ['generated_values']
              : []
      auditTable(this, table, redact)
    }
  }

  async down() {
    this.schema.raw(`ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_current_version_fk`)
    for (const table of [
      'resource_attachments',
      'document_versions',
      'template_versions',
      'templates',
      'documents',
      'attachments',
    ]) {
      dropTable(this, table)
    }
    for (const fn of [
      'documents_guard',
      'attachments_guard',
      'template_versions_guard',
      'documents_append_only',
    ]) {
      this.schema.raw(`DROP FUNCTION IF EXISTS ${fn}()`)
    }
  }
}
