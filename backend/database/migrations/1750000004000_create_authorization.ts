import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  createGlobalTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Autorização (C06). `permissions` é um catálogo **global** (igual em todos os tenants, semeado a
 * partir do código). Papéis, atribuições e políticas são de tenant (RLS forçada, FKs compostas).
 * `organization_unit_id` não tem FK por agora: as unidades chegam na fatia 1.5.
 */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'permissions', (table) => {
      table.string('code', 100).notNullable().unique()
      table.string('module_code', 60).notNullable()
      table.string('resource', 60).notNullable()
      table.string('action', 40).notNullable()
      table.string('description', 300).notNullable()
    })
    this.schema.raw(
      `ALTER TABLE permissions ADD CONSTRAINT permissions_code_format CHECK (code = resource || '.' || action AND code ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$')`
    )

    createTenantTable(this, 'roles', (table) => {
      table.string('code', 60).notNullable()
      table.string('name', 120).notNullable()
      table.string('description', 300).nullable()
      table.boolean('is_system').notNullable().defaultTo(false)
      table.unique(['tenant_id', 'code'], { indexName: 'roles_tenant_code_unique' })
    })

    createTenantTable(this, 'role_permissions', (table) => {
      table.uuid('role_id').notNullable()
      table
        .uuid('permission_id')
        .notNullable()
        .references('id')
        .inTable('permissions')
        .onDelete('RESTRICT')
      tenantForeignKey(table, 'role_id', 'roles', { onDelete: 'CASCADE' })
      table.unique(['tenant_id', 'role_id', 'permission_id'], {
        indexName: 'role_permissions_unique',
      })
    })

    createTenantTable(this, 'role_assignments', (table) => {
      table.uuid('membership_id').notNullable()
      table.uuid('role_id').notNullable()
      table.uuid('organization_unit_id').nullable()
      table.timestamp('valid_from', { useTz: true }).nullable()
      table.timestamp('valid_until', { useTz: true }).nullable()
      tenantForeignKey(table, 'membership_id', 'tenant_memberships', { onDelete: 'CASCADE' })
      tenantForeignKey(table, 'role_id', 'roles')
      table.index(['tenant_id', 'membership_id'], 'role_assignments_membership_index')
      table.check(
        'valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from',
        [],
        'role_assignments_window_check'
      )
    })
    this.schema.raw(`
      CREATE UNIQUE INDEX role_assignments_unique ON role_assignments
        (tenant_id, membership_id, role_id, COALESCE(organization_unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
    `)

    createTenantTable(this, 'access_policies', (table) => {
      table.string('name', 120).notNullable()
      // '*' = qualquer recurso/acção.
      table.string('resource', 60).notNullable()
      table.string('action', 40).notNullable()
      table
        .enum('effect', ['ALLOW', 'DENY'], {
          useNative: false,
          enumName: 'access_policies_effect_check',
        })
        .notNullable()
      table.jsonb('condition_ast').nullable()
      table.integer('priority').notNullable().defaultTo(0)
      table
        .enum('status', ['DRAFT', 'ACTIVE', 'DISABLED'], {
          useNative: false,
          enumName: 'access_policies_status_check',
        })
        .notNullable()
        .defaultTo('DRAFT')
      table.jsonb('field_rules').notNullable().defaultTo('[]')
      table.index(['tenant_id', 'resource', 'action'], 'access_policies_target_index')
    })
  }

  async down() {
    dropTable(this, 'access_policies')
    dropTable(this, 'role_assignments')
    dropTable(this, 'role_permissions')
    dropTable(this, 'roles')
    dropTable(this, 'permissions')
  }
}
