import { BaseSchema } from '@adonisjs/lucid/schema'
import { createGlobalTable } from '#database/support/tables'

/**
 * Subscrições (bloco 3.5), plano de controlo (tabelas globais, sem dados de negócio dos tenants):
 *  - `features`: catálogo do código (`node ace catalog:sync` sincroniza também este catálogo);
 *  - `plans` + `plan_features`: um plano só muda em DRAFT; publicado (ACTIVE) fica imutável (trigger);
 *  - `subscriptions`: no máximo uma subscrição corrente por tenant (índice parcial);
 *  - `subscription_events`: histórico só de acrescentar (trigger);
 *  - `tenant_entitlement_overrides`: excepções por tenant (ligar/desligar ou mudar limite), com motivo e validade.
 * A funcionalidade contratada não substitui a permissão RBAC: uma rota pode exigir as duas.
 */
export default class extends BaseSchema {
  async up() {
    createGlobalTable(this, 'features', (table) => {
      table.string('code', 80).notNullable().unique()
      table.string('module', 40).notNullable()
      table.string('kind', 10).notNullable()
      table.string('description', 300).notNullable()
      table.check("kind IN ('BOOLEAN', 'LIMIT')", [], 'features_kind_check')
    })

    createGlobalTable(this, 'plans', (table) => {
      table.string('code', 40).notNullable().unique()
      table.string('name', 120).notNullable()
      table.string('description', 500).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.integer('trial_days').notNullable().defaultTo(0)
      table.timestamp('published_at', { useTz: true }).nullable()
      table.integer('version').notNullable().defaultTo(1)
      table.check("status IN ('DRAFT', 'ACTIVE', 'RETIRED')", [], 'plans_status_check')
      table.check('trial_days BETWEEN 0 AND 365', [], 'plans_trial_check')
    })

    createGlobalTable(this, 'plan_features', (table) => {
      table.uuid('plan_id').notNullable().references('id').inTable('plans').onDelete('CASCADE')
      table
        .string('feature_code', 80)
        .notNullable()
        .references('code')
        .inTable('features')
        .onDelete('RESTRICT')
      table.boolean('enabled').notNullable().defaultTo(true)
      table.integer('limit_value').nullable()
      table.unique(['plan_id', 'feature_code'], { indexName: 'plan_features_unique' })
      table.check('limit_value IS NULL OR limit_value >= 0', [], 'plan_features_limit_check')
    })
    this.schema.raw(`
      CREATE FUNCTION plan_features_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE plan_status text;
      BEGIN
        SELECT status INTO plan_status FROM plans WHERE id = COALESCE(NEW.plan_id, OLD.plan_id);
        IF plan_status IS NOT NULL AND plan_status <> 'DRAFT' THEN
          RAISE EXCEPTION 'PLAN_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER plan_features_guard BEFORE INSERT OR UPDATE OR DELETE ON plan_features
      FOR EACH ROW EXECUTE FUNCTION plan_features_guard()`)

    createGlobalTable(this, 'subscriptions', (table) => {
      table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT')
      table.uuid('plan_id').notNullable().references('id').inTable('plans').onDelete('RESTRICT')
      table.string('status', 12).notNullable()
      table.timestamp('starts_at', { useTz: true }).notNullable()
      table.timestamp('trial_ends_at', { useTz: true }).nullable()
      table.timestamp('ends_at', { useTz: true }).nullable()
      table.integer('version').notNullable().defaultTo(1)
      table.index(['tenant_id'], 'subscriptions_tenant_index')
      table.check(
        "status IN ('TRIALING', 'ACTIVE', 'SUSPENDED', 'CANCELLED')",
        [],
        'subscriptions_status_check'
      )
      table.check(
        "status <> 'TRIALING' OR trial_ends_at IS NOT NULL",
        [],
        'subscriptions_trial_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX subscriptions_current_unique ON subscriptions (tenant_id)
      WHERE status IN ('TRIALING', 'ACTIVE', 'SUSPENDED')`)

    createGlobalTable(this, 'subscription_events', (table) => {
      table
        .uuid('subscription_id')
        .notNullable()
        .references('id')
        .inTable('subscriptions')
        .onDelete('RESTRICT')
      table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT')
      table.string('action', 20).notNullable()
      table.string('from_status', 12).nullable()
      table.string('to_status', 12).notNullable()
      table.uuid('plan_id').notNullable()
      table.uuid('actor_user_id').nullable()
      table.string('reason', 500).nullable()
      table.index(['tenant_id', 'created_at'], 'subscription_events_tenant_index')
    })
    this.schema.raw(`
      CREATE FUNCTION subscription_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SUBSCRIPTION_HISTORY_APPEND_ONLY' USING ERRCODE = '23000'; END $$`)
    this.schema
      .raw(`CREATE TRIGGER subscription_events_append_only BEFORE UPDATE OR DELETE ON subscription_events
      FOR EACH ROW EXECUTE FUNCTION subscription_events_append_only()`)

    createGlobalTable(this, 'tenant_entitlement_overrides', (table) => {
      table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE')
      table
        .string('feature_code', 80)
        .notNullable()
        .references('code')
        .inTable('features')
        .onDelete('RESTRICT')
      table.boolean('enabled').notNullable()
      table.integer('limit_value').nullable()
      table.string('reason', 500).notNullable()
      table.timestamp('expires_at', { useTz: true }).nullable()
      table.uuid('created_by').nullable()
      table.unique(['tenant_id', 'feature_code'], {
        indexName: 'tenant_entitlement_overrides_unique',
      })
      table.check(
        'limit_value IS NULL OR limit_value >= 0',
        [],
        'tenant_entitlement_overrides_limit_check'
      )
    })
  }

  async down() {
    this.schema.dropTable('tenant_entitlement_overrides')
    this.schema.raw('DROP TRIGGER subscription_events_append_only ON subscription_events')
    this.schema.dropTable('subscription_events')
    this.schema.raw('DROP FUNCTION subscription_events_append_only()')
    this.schema.dropTable('subscriptions')
    this.schema.raw('DROP TRIGGER plan_features_guard ON plan_features')
    this.schema.dropTable('plan_features')
    this.schema.raw('DROP FUNCTION plan_features_guard()')
    this.schema.dropTable('plans')
    this.schema.dropTable('features')
  }
}
