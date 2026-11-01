import { BaseSchema } from '@adonisjs/lucid/schema'
import { auditTable, createGlobalTable, dropTable } from '#database/support/tenant_tables'

/**
 * Planos, assinaturas e limites (C02). São tabelas **globais** do plano de controlo (D-030):
 *
 *  - `plan_versions`: versão de um plano. Depois de PUBLISHED é imutável (só passa a RETIRED); um DRAFT
 *    é a única versão editável ou apagável. Os limites e direitos são `jsonb` validados pela aplicação.
 *  - `subscriptions`: no máximo uma assinatura não cancelada por tenant (índice parcial único).
 *  - `subscription_changes`: histórico append-only (atribuição, upgrade, downgrade, estado).
 *
 * Substitui a quota provisória `tenants.max_members` (contract do expand/contract iniciado na 1.6).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_max_members_check`)
    this.schema.alterTable('tenants', (table) => {
      table.dropColumn('max_members')
    })

    createGlobalTable(this, 'plan_versions', (table) => {
      table.string('plan_code', 60).notNullable()
      table.integer('revision').notNullable()
      table.string('name', 160).notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('price', 19, 4).notNullable()
      table.string('billing_interval', 5).notNullable()
      table.jsonb('limits').notNullable()
      table.jsonb('entitlements').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.timestamp('published_at', { useTz: true }).nullable()
      table.unique(['plan_code', 'revision'])
    })
    this.schema.raw(`
      ALTER TABLE plan_versions
        ADD CONSTRAINT plan_versions_price_check CHECK (price >= 0),
        ADD CONSTRAINT plan_versions_revision_check CHECK (revision >= 1),
        ADD CONSTRAINT plan_versions_interval_check CHECK (billing_interval IN ('MONTH', 'YEAR')),
        ADD CONSTRAINT plan_versions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED'))
    `)
    this.schema.raw(`
      CREATE FUNCTION plan_versions_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status <> 'DRAFT' THEN
            RAISE EXCEPTION 'Uma versão de plano publicada não se apaga' USING ERRCODE = '42501';
          END IF;
          RETURN OLD;
        END IF;
        IF OLD.status = 'DRAFT' THEN
          RETURN NEW;
        END IF;
        -- Publicada ou retirada: só PUBLISHED → RETIRED, sem tocar em mais nada.
        IF OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
           AND (NEW.plan_code, NEW.revision, NEW.name, NEW.currency, NEW.price, NEW.billing_interval,
                NEW.limits, NEW.entitlements, NEW.published_at)
               IS NOT DISTINCT FROM
               (OLD.plan_code, OLD.revision, OLD.name, OLD.currency, OLD.price, OLD.billing_interval,
                OLD.limits, OLD.entitlements, OLD.published_at) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Uma versão de plano publicada é imutável' USING ERRCODE = '42501';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER plan_versions_guard BEFORE UPDATE OR DELETE ON plan_versions
        FOR EACH ROW EXECUTE FUNCTION plan_versions_guard()
    `)

    createGlobalTable(this, 'subscriptions', (table) => {
      table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT')
      table
        .uuid('plan_version_id')
        .notNullable()
        .references('id')
        .inTable('plan_versions')
        .onDelete('RESTRICT')
      table.string('status', 10).notNullable()
      table.timestamp('starts_at', { useTz: true }).notNullable()
      table.timestamp('period_end', { useTz: true }).notNullable()
      table.timestamp('trial_end', { useTz: true }).nullable()
      table.timestamp('grace_end', { useTz: true }).nullable()
      table.timestamp('adequacy_until', { useTz: true }).nullable()
      table.string('external_customer_id', 160).nullable()
      table.boolean('cancel_at_period_end').notNullable().defaultTo(false)
      table.index(['tenant_id'])
    })
    this.schema.raw(`
      ALTER TABLE subscriptions
        ADD CONSTRAINT subscriptions_status_check
          CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'))
    `)
    this.schema.raw(
      `CREATE UNIQUE INDEX subscriptions_one_open_per_tenant ON subscriptions (tenant_id) WHERE status <> 'CANCELLED'`
    )

    // Alterações à assinatura entram também na auditoria do tenant (antes/depois, actor e correlação).
    auditTable(this, 'subscriptions')

    createGlobalTable(this, 'subscription_changes', (table) => {
      table
        .uuid('subscription_id')
        .notNullable()
        .references('id')
        .inTable('subscriptions')
        .onDelete('RESTRICT')
      table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT')
      table.string('kind', 20).notNullable()
      table.uuid('from_plan_version_id').nullable().references('id').inTable('plan_versions')
      table.uuid('to_plan_version_id').nullable().references('id').inTable('plan_versions')
      table.string('from_status', 10).nullable()
      table.string('to_status', 10).nullable()
      table.timestamp('adequacy_until', { useTz: true }).nullable()
      table.jsonb('detail').notNullable().defaultTo('{}')
      table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['tenant_id', 'occurred_at'])
    })
    this.schema.raw(`
      ALTER TABLE subscription_changes
        ADD CONSTRAINT subscription_changes_kind_check
          CHECK (kind IN ('ASSIGNED', 'UPGRADED', 'DOWNGRADED', 'PLAN_CHANGED', 'STATUS_CHANGED'))
    `)
    // Histórico imutável (mesma regra e mesmo desvio de retenção da auditoria).
    this.schema.raw(`
      CREATE TRIGGER subscription_changes_immutable BEFORE UPDATE OR DELETE ON subscription_changes
        FOR EACH ROW EXECUTE FUNCTION audit_forbid_change()
    `)
  }

  async down() {
    dropTable(this, 'subscription_changes')
    dropTable(this, 'subscriptions')
    dropTable(this, 'plan_versions')
    this.schema.raw(`DROP FUNCTION IF EXISTS plan_versions_guard()`)
    this.schema.alterTable('tenants', (table) => {
      table.integer('max_members').nullable()
    })
    this.schema.raw(
      `ALTER TABLE tenants ADD CONSTRAINT tenants_max_members_check CHECK (max_members IS NULL OR max_members >= 1)`
    )
  }
}
