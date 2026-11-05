import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable } from '#database/support/tables'

/**
 * Anexos (bloco 3.6): metadados por tenant com RLS; o ficheiro fica no armazenamento local, num caminho gerado pelo
 * servidor (`<tenant>/<prefixo>/<id>`), nunca o nome enviado. O acesso herda do registo a que o anexo pertence
 * (`subject_type`/`subject_id`). Eliminação lógica: o ficheiro e os metadados ficam para a auditoria.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'attachments', (table) => {
      table.string('subject_type', 60).notNullable()
      table.uuid('subject_id').notNullable()
      table.string('file_name', 200).notNullable()
      table.string('content_type', 100).notNullable()
      table.bigInteger('size_bytes').notNullable()
      table.specificType('sha256', 'char(64)').notNullable()
      table.string('storage_key', 200).notNullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.timestamp('deleted_at', { useTz: true }).nullable()
      table.uuid('deleted_by').nullable()
      table.unique(['storage_key'], { indexName: 'attachments_storage_key_unique' })
      table.index(['tenant_id', 'subject_type', 'subject_id'], 'attachments_subject_index')
      table.check('size_bytes > 0', [], 'attachments_size_check')
      table.check("status IN ('ACTIVE', 'DELETED')", [], 'attachments_status_check')
      table.check(
        "(status = 'DELETED') = (deleted_at IS NOT NULL)",
        [],
        'attachments_deleted_check'
      )
    })
  }

  async down() {
    this.schema.dropTable('attachments')
  }
}
