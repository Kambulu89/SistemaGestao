import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Notificações e comunicação (S02). Um **pedido** de notificação nasce do outbox ou de um comando autorizado e é único
 * por `dedupe_key` (um replay não duplica). Cada pedido gera **entregas** por canal; `SENT` significa aceite pelo
 * fornecedor e `DELIVERED` só existe depois da confirmação. O destino de um canal externo guarda-se cifrado. O **centro**
 * (`notifications`) é por destinatário: marcar como lida afecta só a própria pessoa.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'notification_requests', (table) => {
      table.string('type_code', 80).notNullable()
      table.string('template_version', 20).notNullable()
      table.string('classification', 20).notNullable()
      table.uuid('recipient_membership_id').nullable()
      table.uuid('recipient_party_id').nullable()
      // Dados mínimos para renderizar o texto: nunca segredos nem dados desnecessários.
      table.jsonb('payload').notNullable().defaultTo('{}')
      table.string('dedupe_key', 160).notNullable()
      table.string('resource_type', 40).nullable()
      table.uuid('resource_id').nullable()
      table.string('status', 12).notNullable().defaultTo('PENDING')
      tenantForeignKey(table, 'recipient_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'recipient_party_id', 'parties')
      table.unique(['tenant_id', 'dedupe_key'], {
        indexName: 'notification_requests_dedupe_unique',
      })
      table.index(['tenant_id', 'status'], 'notification_requests_status_index')
    })
    this.schema.raw(`
      ALTER TABLE notification_requests
        ADD CONSTRAINT notification_requests_status_check
          CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
        ADD CONSTRAINT notification_requests_class_check
          CHECK (classification IN ('MANDATORY', 'OPERATIONAL', 'PROMOTIONAL'))
    `)

    createTenantTable(this, 'notification_deliveries', (table) => {
      table.uuid('request_id').notNullable()
      table.string('channel', 10).notNullable()
      // Destino cifrado (AES-256-GCM); `destination_hint` é só uma máscara para os administradores.
      table.text('destination_encrypted').nullable()
      table.string('destination_hint', 80).nullable()
      table.string('status', 10).notNullable().defaultTo('QUEUED')
      table.string('provider', 40).nullable()
      table.string('provider_message_id', 160).nullable()
      table.integer('attempts').notNullable().defaultTo(0)
      table.string('last_error_code', 60).nullable()
      table.string('last_error', 300).nullable()
      table.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('locked_until', { useTz: true }).nullable()
      table.timestamp('sent_at', { useTz: true }).nullable()
      table.timestamp('delivered_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'request_id', 'notification_requests')
      table.unique(['tenant_id', 'request_id', 'channel'], {
        indexName: 'notification_deliveries_channel_unique',
      })
      table.index(['tenant_id', 'status', 'next_attempt_at'], 'notification_deliveries_due_index')
    })
    this.schema.raw(`
      ALTER TABLE notification_deliveries
        ADD CONSTRAINT notification_deliveries_channel_check
          CHECK (channel IN ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH')),
        ADD CONSTRAINT notification_deliveries_status_check
          CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'FAILED')),
        ADD CONSTRAINT notification_deliveries_attempts_check CHECK (attempts >= 0)
    `)

    createTenantTable(this, 'notifications', (table) => {
      table.uuid('recipient_membership_id').notNullable()
      table.uuid('request_id').nullable()
      table.string('type_code', 80).notNullable()
      table.string('title', 200).notNullable()
      table.text('body').notNullable()
      table.string('resource_type', 40).nullable()
      table.uuid('resource_id').nullable()
      table.timestamp('read_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'recipient_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'request_id', 'notification_requests')
      table.index(
        ['tenant_id', 'recipient_membership_id', 'read_at', 'created_at'],
        'notifications_recipient_index'
      )
    })

    createTenantTable(this, 'notification_preferences', (table) => {
      table.uuid('membership_id').notNullable()
      table.string('type_code', 80).notNullable()
      table.string('channel', 10).notNullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.jsonb('quiet_hours').nullable()
      tenantForeignKey(table, 'membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'membership_id', 'type_code', 'channel'], {
        indexName: 'notification_preferences_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE notification_preferences
        ADD CONSTRAINT notification_preferences_channel_check
          CHECK (channel IN ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH'))
    `)

    for (const table of [
      'notification_requests',
      'notification_deliveries',
      'notifications',
      'notification_preferences',
    ]) {
      // O destino cifrado e o texto das notificações não entram em claro na auditoria.
      const redact =
        table === 'notification_deliveries'
          ? ['destination_encrypted', 'destination_hint']
          : table === 'notifications'
            ? ['title', 'body']
            : table === 'notification_requests'
              ? ['payload']
              : []
      auditTable(this, table, redact)
    }
  }

  async down() {
    for (const table of [
      'notification_preferences',
      'notifications',
      'notification_deliveries',
      'notification_requests',
    ]) {
      dropTable(this, table)
    }
  }
}
