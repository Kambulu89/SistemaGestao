import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Calendário, recursos e reservas (S03). Um **evento** pertence a um calendário e pode repetir-se (regra num subconjunto
 * de RRULE); cada ocorrência é identificada pelo seu início original, e as **excepções** (cancelada ou alterada)
 * guardam-se à parte para uma ocorrência cancelada nunca reaparecer. Uma **reserva** liga um evento a um recurso e a
 * sobreposição impede-se **na base de dados** com uma restrição de exclusão sobre `[início, fim)`: duas reservas
 * concorrentes do mesmo horário só deixam passar uma, mesmo sem a aplicação.
 */
export default class extends BaseSchema {
  async up() {
    // Igualdade de UUID dentro de um índice GiST (a restrição de exclusão).
    this.schema.raw('CREATE EXTENSION btree_gist')

    createTenantTable(this, 'calendars', (table) => {
      table.string('name', 160).notNullable()
      table.uuid('owner_membership_id').nullable()
      table.uuid('unit_id').nullable()
      table.string('timezone', 64).notNullable()
      table.string('visibility', 10).notNullable().defaultTo('PRIVATE')
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'unit_id', 'organization_units')
      table.index(['tenant_id', 'visibility'], 'calendars_visibility_index')
    })
    this.schema.raw(`
      ALTER TABLE calendars
        ADD CONSTRAINT calendars_visibility_check CHECK (visibility IN ('PRIVATE', 'UNIT', 'TENANT')),
        ADD CONSTRAINT calendars_private_owner_check
          CHECK (visibility <> 'PRIVATE' OR owner_membership_id IS NOT NULL),
        ADD CONSTRAINT calendars_unit_check CHECK (visibility <> 'UNIT' OR unit_id IS NOT NULL)
    `)

    createTenantTable(this, 'resources', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('unit_id').nullable()
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('type', 10).notNullable()
      table.integer('capacity').notNullable().defaultTo(1)
      table.boolean('active').notNullable().defaultTo(true)
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'unit_id', 'organization_units')
      table.unique(['tenant_id', 'code'], { indexName: 'resources_code_unique' })
    })
    this.schema.raw(`
      ALTER TABLE resources
        ADD CONSTRAINT resources_type_check CHECK (type IN ('ROOM', 'EQUIPMENT', 'VEHICLE', 'OTHER')),
        ADD CONSTRAINT resources_capacity_check CHECK (capacity >= 1)
    `)

    createTenantTable(this, 'calendar_events', (table) => {
      table.uuid('calendar_id').notNullable()
      table.string('title', 200).notNullable()
      table.text('description').nullable()
      table.timestamp('starts_at', { useTz: true }).notNullable()
      table.timestamp('ends_at', { useTz: true }).notNullable()
      table.string('timezone', 64).notNullable()
      table.boolean('all_day').notNullable().defaultTo(false)
      table.string('recurrence_rule', 500).nullable()
      table.string('status', 10).notNullable().defaultTo('CONFIRMED')
      table.string('source_type', 50).nullable()
      table.string('source_id', 64).nullable()
      tenantForeignKey(table, 'calendar_id', 'calendars')
      table.index(['tenant_id', 'calendar_id', 'starts_at'], 'calendar_events_calendar_index')
      table.index(['tenant_id', 'source_type', 'source_id'], 'calendar_events_source_index')
    })
    this.schema.raw(`
      ALTER TABLE calendar_events
        ADD CONSTRAINT calendar_events_status_check CHECK (status IN ('TENTATIVE', 'CONFIRMED', 'CANCELLED')),
        ADD CONSTRAINT calendar_events_range_check CHECK (ends_at > starts_at),
        ADD CONSTRAINT calendar_events_source_check CHECK ((source_type IS NULL) = (source_id IS NULL))
    `)

    // Uma excepção a uma série: a ocorrência cancelada (para nunca reaparecer) ou alterada.
    createTenantTable(this, 'calendar_event_exceptions', (table) => {
      table.uuid('event_id').notNullable()
      table.timestamp('occurrence_start', { useTz: true }).notNullable()
      table.string('kind', 10).notNullable()
      table.string('title', 200).nullable()
      table.timestamp('starts_at', { useTz: true }).nullable()
      table.timestamp('ends_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'event_id', 'calendar_events', { onDelete: 'CASCADE' })
      table.unique(['event_id', 'occurrence_start'], {
        indexName: 'calendar_event_exceptions_occurrence_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE calendar_event_exceptions
        ADD CONSTRAINT calendar_event_exceptions_kind_check CHECK (kind IN ('CANCELLED', 'MODIFIED')),
        ADD CONSTRAINT calendar_event_exceptions_modified_check
          CHECK (kind = 'CANCELLED' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at))
    `)

    createTenantTable(this, 'resource_bookings', (table) => {
      table.uuid('event_id').notNullable()
      table.uuid('resource_id').notNullable()
      table.timestamp('occurrence_start', { useTz: true }).nullable()
      table.timestamp('starts_at', { useTz: true }).notNullable()
      table.timestamp('ends_at', { useTz: true }).notNullable()
      table.string('status', 10).notNullable()
      table.timestamp('expires_at', { useTz: true }).nullable()
      table.string('cancel_reason', 20).nullable()
      tenantForeignKey(table, 'event_id', 'calendar_events')
      tenantForeignKey(table, 'resource_id', 'resources')
      table.index(['tenant_id', 'resource_id', 'starts_at'], 'resource_bookings_resource_index')
      table.index(['tenant_id', 'event_id'], 'resource_bookings_event_index')
    })
    this.schema.raw(`
      ALTER TABLE resource_bookings
        ADD CONSTRAINT resource_bookings_status_check CHECK (status IN ('HELD', 'CONFIRMED', 'CANCELLED')),
        ADD CONSTRAINT resource_bookings_range_check CHECK (ends_at > starts_at),
        ADD CONSTRAINT resource_bookings_hold_check CHECK ((status = 'HELD') = (expires_at IS NOT NULL)),
        ADD CONSTRAINT resource_bookings_cancel_check CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
        ADD CONSTRAINT resource_bookings_no_overlap EXCLUDE USING gist (
          resource_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        ) WHERE (status IN ('HELD', 'CONFIRMED'))
    `)
    // Uma ocorrência (ou o evento único) só tem uma reserva activa por recurso.
    this.schema.raw(`
      CREATE UNIQUE INDEX resource_bookings_active_unique
        ON resource_bookings (event_id, resource_id, COALESCE(occurrence_start, 'epoch'::timestamptz))
        WHERE status <> 'CANCELLED'
    `)

    createTenantTable(this, 'event_participants', (table) => {
      table.uuid('event_id').notNullable()
      table.uuid('membership_id').nullable()
      table.uuid('party_id').nullable()
      table.string('response', 10).notNullable().defaultTo('PENDING')
      tenantForeignKey(table, 'event_id', 'calendar_events', { onDelete: 'CASCADE' })
      tenantForeignKey(table, 'membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'party_id', 'parties')
    })
    this.schema.raw(`
      ALTER TABLE event_participants
        ADD CONSTRAINT event_participants_response_check CHECK (response IN ('PENDING', 'ACCEPTED', 'DECLINED')),
        ADD CONSTRAINT event_participants_one_check CHECK (num_nonnulls(membership_id, party_id) = 1)
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX event_participants_membership_unique
        ON event_participants (event_id, membership_id) WHERE membership_id IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX event_participants_party_unique
        ON event_participants (event_id, party_id) WHERE party_id IS NOT NULL
    `)

    createTenantTable(this, 'business_calendars', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('name', 160).notNullable()
      table.string('timezone', 64).notNullable()
      table.jsonb('weekly_working_hours').notNullable().defaultTo('{}')
      table.jsonb('holidays').notNullable().defaultTo('[]')
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.unique(['tenant_id', 'organization_id', 'name'], {
        indexName: 'business_calendars_name_unique',
      })
    })

    for (const table of [
      'calendars',
      'resources',
      'calendar_events',
      'calendar_event_exceptions',
      'resource_bookings',
      'event_participants',
      'business_calendars',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    for (const table of [
      'business_calendars',
      'event_participants',
      'resource_bookings',
      'calendar_event_exceptions',
      'calendar_events',
      'resources',
      'calendars',
    ]) {
      dropTable(this, table)
    }
    this.schema.raw('DROP EXTENSION btree_gist')
  }
}
