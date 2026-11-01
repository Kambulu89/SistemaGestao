import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, dropTable } from '#database/support/tenant_tables'

/**
 * Outbox transaccional: o evento escreve-se na **mesma transacção** que a alteração que o originou, por isso nunca há
 * alteração sem evento nem evento sem alteração. A publicação (worker) e os consumidores com inbox ainda não existem:
 * os eventos ficam `PENDING` até haver o primeiro consumidor real (ver D-015 e D-042).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'outbox_events', (table) => {
      table.string('aggregate_type', 60).notNullable()
      table.uuid('aggregate_id').notNullable()
      table.integer('aggregate_version').notNullable()
      table.string('event_type', 100).notNullable()
      table.jsonb('payload').notNullable()
      table.string('correlation_id', 100).nullable()
      table.string('status', 10).notNullable().defaultTo('PENDING')
      table.timestamp('available_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.integer('attempts').notNullable().defaultTo(0)
      table.timestamp('published_at', { useTz: true }).nullable()
      table.index(['tenant_id', 'status', 'available_at'], 'outbox_events_pending_index')
      table.index(['tenant_id', 'aggregate_type', 'aggregate_id'], 'outbox_events_aggregate_index')
    })
    this.schema.raw(`
      ALTER TABLE outbox_events
        ADD CONSTRAINT outbox_events_status_check CHECK (status IN ('PENDING', 'PUBLISHED')),
        ADD CONSTRAINT outbox_events_payload_check CHECK (jsonb_typeof(payload) = 'object'),
        ADD CONSTRAINT outbox_events_published_check CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL))
    `)
  }

  async down() {
    dropTable(this, 'outbox_events')
  }
}
