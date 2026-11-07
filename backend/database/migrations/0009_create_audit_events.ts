import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Auditoria (bloco 3.6): `audit_events` por tenant, com RLS, escrito na **mesma** transacção da operação auditada (ou
 * fica tudo, ou nada). Só de acrescentar: a conta de runtime não tem UPDATE/DELETE/TRUNCATE e um trigger recusa
 * alterações mesmo a quem tenha. Nunca guarda palavras-passe, tokens nem hashes (o domínio retira-os antes).
 */
export default class extends BaseSchema {
  async up() {
    const runtime = env.get('DB_USER')
    createTenantTable(this, 'audit_events', (table) => {
      table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.uuid('actor_user_id').nullable().references('id').inTable('users').onDelete('RESTRICT')
      table.uuid('actor_membership_id').nullable()
      table.string('request_id', 64).nullable()
      table.string('action', 80).notNullable()
      table.string('entity_type', 60).notNullable()
      table.uuid('entity_id').nullable()
      table.jsonb('changes').nullable()
      table.jsonb('metadata').nullable()
      tenantForeignKey(table, 'actor_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'occurred_at'], 'audit_events_occurred_index')
      table.index(['tenant_id', 'entity_type', 'entity_id'], 'audit_events_entity_index')
      table.index(['tenant_id', 'actor_user_id'], 'audit_events_actor_index')
    })
    this.schema.raw(`
      CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'AUDIT_APPEND_ONLY' USING ERRCODE = '23000'; END $$`)
    this.schema.raw(`CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION audit_events_append_only()`)
    this.schema.raw(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM "${runtime}"`)
  }

  async down() {
    this.schema.raw('DROP TRIGGER audit_events_append_only ON audit_events')
    this.schema.dropTable('audit_events')
    this.schema.raw('DROP FUNCTION audit_events_append_only()')
  }
}
