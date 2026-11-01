import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, dropTable, tenantForeignKey } from '#database/support/tenant_tables'

/**
 * Convites e preferências (C05). `invitations` guarda só o hash do token; o token inclui o id do
 * tenant (apenas para o localizar: a prova é o segredo). `tenants.max_members` é a quota provisória
 * de membros por tenant (NULL = sem limite) até existirem planos e assinaturas (C02).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('tenants', (table) => {
      table.integer('max_members').nullable()
    })
    this.schema.raw(
      `ALTER TABLE tenants ADD CONSTRAINT tenants_max_members_check CHECK (max_members IS NULL OR max_members >= 1)`
    )

    createTenantTable(this, 'invitations', (table) => {
      table.string('email', 254).notNullable()
      table.string('token_hash', 255).notNullable()
      table.uuid('invited_by_membership_id').nullable()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('accepted_at', { useTz: true }).nullable()
      table
        .enum('status', ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'], {
          useNative: false,
          enumName: 'invitations_status_check',
        })
        .notNullable()
        .defaultTo('PENDING')
      // Validados pela aplicação (existem no tenant) quando o convite é criado e outra vez ao aceitar.
      table.jsonb('role_ids').notNullable().defaultTo('[]')
      table.jsonb('unit_ids').notNullable().defaultTo('[]')
      tenantForeignKey(table, 'invited_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'token_hash'], { indexName: 'invitations_token_unique' })
      table.check('email = lower(btrim(email))', [], 'invitations_email_normalized')
    })
    // No máximo um convite pendente por email e tenant.
    this.schema.raw(
      `CREATE UNIQUE INDEX invitations_one_pending ON invitations (tenant_id, email) WHERE status = 'PENDING'`
    )

    createTenantTable(this, 'user_preferences', (table) => {
      table.uuid('membership_id').notNullable()
      table.string('key', 100).notNullable()
      table.jsonb('value').notNullable()
      tenantForeignKey(table, 'membership_id', 'tenant_memberships', { onDelete: 'CASCADE' })
      table.unique(['tenant_id', 'membership_id', 'key'], {
        indexName: 'user_preferences_unique',
      })
    })
  }

  async down() {
    dropTable(this, 'user_preferences')
    dropTable(this, 'invitations')
    this.schema.raw(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_max_members_check`)
    this.schema.alterTable('tenants', (table) => {
      table.dropColumn('max_members')
    })
  }
}
