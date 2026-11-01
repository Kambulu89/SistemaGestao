import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createGlobalTable,
  createTenantTable,
  dropTable,
} from '#database/support/tenant_tables'

/**
 * Registo de módulos e funcionalidades (C03).
 *
 *  - Globais (catálogo entregue por código; ver D-031): `modules`, `module_dependencies`, `features`.
 *    Nunca se apagam linhas: um módulo que sai do código passa a DEPRECATED.
 *  - De tenant: `tenant_modules` (estado de activação e configuração) e `tenant_features` (override
 *    por funcionalidade, com motivo e prazo). Ambas auditadas. Desactivar nunca apaga dados.
 */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'modules', (table) => {
      table.string('code', 40).notNullable().unique()
      table.string('name', 160).notNullable()
      table.string('release_version', 30).notNullable()
      table.string('status', 12).notNullable().defaultTo('AVAILABLE')
      table.jsonb('manifest').notNullable()
      table.string('min_core_version', 30).notNullable()
    })
    this.schema.raw(`
      ALTER TABLE modules
        ADD CONSTRAINT modules_status_check CHECK (status IN ('AVAILABLE', 'DEPRECATED'))
    `)

    createGlobalTable(this, 'module_dependencies', (table) => {
      table.uuid('module_id').notNullable().references('id').inTable('modules').onDelete('RESTRICT')
      table
        .uuid('required_module_id')
        .notNullable()
        .references('id')
        .inTable('modules')
        .onDelete('RESTRICT')
      table.string('version_constraint', 50).notNullable().defaultTo('*')
      table.boolean('optional').notNullable().defaultTo(false)
      table.unique(['module_id', 'required_module_id'])
    })
    this.schema.raw(`
      ALTER TABLE module_dependencies
        ADD CONSTRAINT module_dependencies_not_self CHECK (module_id <> required_module_id)
    `)

    createGlobalTable(this, 'features', (table) => {
      table.uuid('module_id').notNullable().references('id').inTable('modules').onDelete('RESTRICT')
      table.string('code', 60).notNullable().unique()
      table.string('name', 160).notNullable()
      table.boolean('default_enabled').notNullable().defaultTo(false)
      // Saiu do manifesto: deixa de ser oferecida, mas as referências (overrides) mantêm-se.
      table.boolean('retired').notNullable().defaultTo(false)
    })

    createTenantTable(this, 'tenant_modules', (table) => {
      table.uuid('module_id').notNullable().references('id').inTable('modules').onDelete('RESTRICT')
      table.string('status', 10).notNullable().defaultTo('DISABLED')
      table.jsonb('configuration').notNullable().defaultTo('{}')
      table.timestamp('enabled_at', { useTz: true }).nullable()
      table.string('last_error', 300).nullable()
      table.unique(['tenant_id', 'module_id'])
    })
    this.schema.raw(`
      ALTER TABLE tenant_modules
        ADD CONSTRAINT tenant_modules_status_check
          CHECK (status IN ('DISABLED', 'ENABLING', 'ENABLED', 'DISABLING', 'ERROR'))
    `)
    auditTable(this, 'tenant_modules')

    createTenantTable(this, 'tenant_features', (table) => {
      table
        .uuid('feature_id')
        .notNullable()
        .references('id')
        .inTable('features')
        .onDelete('RESTRICT')
      table.boolean('override').nullable()
      table.text('reason').nullable()
      table.timestamp('expires_at', { useTz: true }).nullable()
      table.unique(['tenant_id', 'feature_id'])
    })
    auditTable(this, 'tenant_features')
  }

  async down() {
    dropTable(this, 'tenant_features')
    dropTable(this, 'tenant_modules')
    dropTable(this, 'features')
    dropTable(this, 'module_dependencies')
    dropTable(this, 'modules')
  }
}
