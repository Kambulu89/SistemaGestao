import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Automações (C15). Uma automação reage a **exactamente um** gatilho — um tipo de evento do outbox ou um calendário — e
 * executa acções declarativas registadas pelos módulos, em nome do membro que a activou (as suas permissões actuais; nunca
 * as da plataforma). Cada execução é uma linha de `automation_runs` com chave de deduplicação única; o consumo do outbox
 * regista-se em `outbox_deliveries` (inbox), por isso um evento nunca é processado duas vezes pelo mesmo consumidor.
 * O outbox passa a registar a causalidade (execução e profundidade) dos eventos que as acções produzem.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'automations', (table) => {
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('description', 500).nullable()
      table.string('event_type', 100).nullable()
      table.string('schedule', 100).nullable()
      table.string('timezone', 64).notNullable()
      table.jsonb('condition_ast').nullable()
      table.jsonb('actions').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.integer('max_runs_per_period').notNullable().defaultTo(60)
      table.uuid('run_as_membership_id').nullable()
      table.timestamp('activated_at', { useTz: true }).nullable()
      table.timestamp('next_run_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'run_as_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'code'], { indexName: 'automations_code_unique' })
    })
    this.schema.raw(`
      ALTER TABLE automations
        ADD CONSTRAINT automations_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
        ADD CONSTRAINT automations_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED')),
        ADD CONSTRAINT automations_trigger_check
          CHECK ((event_type IS NULL) <> (schedule IS NULL)),
        ADD CONSTRAINT automations_actions_check
          CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) BETWEEN 1 AND 10),
        ADD CONSTRAINT automations_period_check CHECK (max_runs_per_period BETWEEN 1 AND 10000),
        ADD CONSTRAINT automations_active_check
          CHECK (status = 'DRAFT' OR (run_as_membership_id IS NOT NULL AND activated_at IS NOT NULL))
    `)

    createTenantTable(this, 'automation_runs', (table) => {
      table.uuid('automation_id').notNullable()
      table.integer('automation_version').notNullable()
      table.uuid('trigger_event_id').nullable()
      table.timestamp('scheduled_for', { useTz: true }).nullable()
      table.string('dedupe_key', 200).notNullable()
      table.string('status', 10).notNullable().defaultTo('PENDING')
      table.integer('attempts').notNullable().defaultTo(0)
      table.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(this.now())
      // Execução que causou o evento que originou esta (a cadeia de causalidade) e a sua profundidade.
      table.uuid('causation_id').nullable()
      table.integer('depth').notNullable().defaultTo(1)
      // Quantas acções já concluíram: uma repetição retoma a seguir, sem repetir envios ou pagamentos feitos.
      table.integer('progress').notNullable().defaultTo(0)
      table.jsonb('payload').notNullable()
      table.text('error').nullable()
      table.string('error_code', 40).nullable()
      table.timestamp('started_at', { useTz: true }).nullable()
      table.timestamp('finished_at', { useTz: true }).nullable()
      table.uuid('retried_by_membership_id').nullable()
      table.timestamp('retried_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'automation_id', 'automations')
      tenantForeignKey(table, 'trigger_event_id', 'outbox_events')
      tenantForeignKey(table, 'retried_by_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'dedupe_key'], { indexName: 'automation_runs_dedupe_unique' })
      table.index(['tenant_id', 'status', 'next_attempt_at'], 'automation_runs_due_index')
      table.index(['tenant_id', 'automation_id', 'created_at'], 'automation_runs_automation_index')
    })
    // Auto-referência: só possível depois de existir a chave única `(tenant_id, id)` da própria tabela.
    this.schema.raw(`
      ALTER TABLE automation_runs
        ADD CONSTRAINT causation_id_tenant_fk FOREIGN KEY (tenant_id, causation_id)
          REFERENCES automation_runs (tenant_id, id) ON DELETE RESTRICT
    `)
    this.schema.raw(`
      ALTER TABLE automation_runs
        ADD CONSTRAINT automation_runs_status_check
          CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD')),
        ADD CONSTRAINT automation_runs_trigger_check
          CHECK ((trigger_event_id IS NOT NULL) <> (scheduled_for IS NOT NULL)),
        ADD CONSTRAINT automation_runs_payload_check CHECK (jsonb_typeof(payload) = 'object'),
        ADD CONSTRAINT automation_runs_depth_check CHECK (depth >= 1),
        ADD CONSTRAINT automation_runs_progress_check CHECK (progress >= 0 AND attempts >= 0)
    `)

    // Inbox do consumo do outbox: um evento só é entregue uma vez a cada consumidor.
    createTenantTable(this, 'outbox_deliveries', (table) => {
      table.string('consumer', 60).notNullable()
      table.uuid('event_id').notNullable()
      tenantForeignKey(table, 'event_id', 'outbox_events')
      table.unique(['tenant_id', 'consumer', 'event_id'], {
        indexName: 'outbox_deliveries_unique',
      })
    })

    this.schema.raw(`
      ALTER TABLE outbox_events
        ADD COLUMN causation_run_id uuid,
        ADD COLUMN causation_depth integer NOT NULL DEFAULT 0,
        ADD CONSTRAINT outbox_events_causation_check CHECK (causation_depth >= 0)
    `)

    auditTable(this, 'automations')
    auditTable(this, 'automation_runs')
  }

  async down() {
    this.schema.raw(`
      ALTER TABLE outbox_events
        DROP CONSTRAINT outbox_events_causation_check,
        DROP COLUMN causation_depth,
        DROP COLUMN causation_run_id
    `)
    dropTable(this, 'outbox_deliveries')
    dropTable(this, 'automation_runs')
    dropTable(this, 'automations')
  }
}
