import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * CRM comercial (M02): leads, pipeline de oportunidades com histórico de transições, actividades e campanhas.
 * Uma lead **converte-se** numa Party, num cliente e numa oportunidade de forma atómica e idempotente (os identificadores
 * ficam gravados na lead). O histórico de transições de uma oportunidade é só de acrescentar: as métricas de conversão
 * usam as datas das transições e não apenas o estado actual. Uma campanha respeita o consentimento e a lista de exclusão.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'pipeline_stages', (table) => {
      table.string('pipeline_code', 40).notNullable().defaultTo('DEFAULT')
      table.string('code', 40).notNullable()
      table.string('name', 120).notNullable()
      table.integer('position').notNullable()
      table.decimal('probability', 5, 4).notNullable()
      table.boolean('terminal').notNullable().defaultTo(false)
      // Só as etapas terminais têm desfecho; ganhar pode exigir evidência comercial (configurável por etapa).
      table.string('outcome', 4).nullable()
      table.boolean('requires_evidence').notNullable().defaultTo(false)
      table.boolean('active').notNullable().defaultTo(true)
      table.unique(['tenant_id', 'pipeline_code', 'code'], {
        indexName: 'pipeline_stages_code_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE pipeline_stages
        ADD CONSTRAINT pipeline_stages_probability_check CHECK (probability >= 0 AND probability <= 1),
        ADD CONSTRAINT pipeline_stages_outcome_check CHECK (outcome IN ('WON', 'LOST')),
        ADD CONSTRAINT pipeline_stages_terminal_check CHECK ((terminal AND outcome IS NOT NULL) OR (NOT terminal AND outcome IS NULL)),
        ADD CONSTRAINT pipeline_stages_evidence_check CHECK (NOT requires_evidence OR outcome = 'WON')
    `)

    createTenantTable(this, 'leads', (table) => {
      table.string('name', 160).notNullable()
      table.string('company_name', 160).nullable()
      table.string('email', 200).nullable()
      table.string('phone', 40).nullable()
      table.string('source', 60).notNullable()
      table.uuid('owner_membership_id').notNullable()
      table.string('status', 12).notNullable().defaultTo('NEW')
      table.string('consent_status', 8).notNullable().defaultTo('UNKNOWN')
      table.string('disqualify_reason', 300).nullable()
      table.uuid('party_id').nullable()
      table.uuid('customer_id').nullable()
      table.uuid('opportunity_id').nullable()
      table.timestamp('converted_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'party_id', 'parties')
      tenantForeignKey(table, 'customer_id', 'customers')
      table.index(['tenant_id', 'status'], 'leads_status_index')
    })
    this.schema.raw(`
      ALTER TABLE leads
        ADD CONSTRAINT leads_status_check CHECK (status IN ('NEW', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED')),
        ADD CONSTRAINT leads_consent_check CHECK (consent_status IN ('UNKNOWN', 'OPT_IN', 'OPT_OUT')),
        ADD CONSTRAINT leads_converted_check CHECK (
          (status = 'CONVERTED') = (converted_at IS NOT NULL AND party_id IS NOT NULL AND customer_id IS NOT NULL)
        )
    `)

    createTenantTable(this, 'opportunities', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('customer_id').nullable()
      table.uuid('lead_id').nullable()
      table.string('name', 200).notNullable()
      table.uuid('owner_membership_id').notNullable()
      table.uuid('stage_id').notNullable()
      table.decimal('expected_value', 19, 4).notNullable().defaultTo(0)
      table.string('currency', 3).notNullable()
      table.date('expected_close_date').nullable()
      table.text('loss_reason').nullable()
      table.text('win_evidence').nullable()
      table.timestamp('closed_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'lead_id', 'leads')
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'stage_id', 'pipeline_stages')
      table.index(['tenant_id', 'stage_id'], 'opportunities_stage_index')
      table.index(['tenant_id', 'owner_membership_id'], 'opportunities_owner_index')
    })
    this.schema.raw(`
      ALTER TABLE opportunities
        ADD CONSTRAINT opportunities_value_check CHECK (expected_value >= 0),
        ADD CONSTRAINT opportunities_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT opportunities_party_check CHECK (customer_id IS NOT NULL OR lead_id IS NOT NULL)
    `)
    // A lead aponta para a oportunidade criada na conversão (FK composta, depois de ambas existirem).
    this.schema.raw(`
      ALTER TABLE leads ADD CONSTRAINT leads_opportunity_fk FOREIGN KEY (tenant_id, opportunity_id)
        REFERENCES opportunities (tenant_id, id)
    `)

    createTenantTable(this, 'opportunity_stage_history', (table) => {
      table.uuid('opportunity_id').notNullable()
      table.uuid('from_stage_id').nullable()
      table.uuid('to_stage_id').notNullable()
      table.timestamp('moved_at', { useTz: true }).notNullable().defaultTo(this.now())
      tenantForeignKey(table, 'opportunity_id', 'opportunities')
      tenantForeignKey(table, 'from_stage_id', 'pipeline_stages')
      tenantForeignKey(table, 'to_stage_id', 'pipeline_stages')
      table.index(['tenant_id', 'opportunity_id', 'moved_at'], 'opportunity_stage_history_index')
      table.index(['tenant_id', 'to_stage_id', 'moved_at'], 'opportunity_stage_history_stage_index')
    })

    createTenantTable(this, 'opportunity_activities', (table) => {
      table.uuid('opportunity_id').notNullable()
      table.string('kind', 8).notNullable()
      table.string('subject', 200).notNullable()
      table.text('notes').nullable()
      table.timestamp('due_at', { useTz: true }).nullable()
      table.timestamp('done_at', { useTz: true }).nullable()
      table.uuid('owner_membership_id').notNullable()
      tenantForeignKey(table, 'opportunity_id', 'opportunities')
      tenantForeignKey(table, 'owner_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'opportunity_id'], 'opportunity_activities_opportunity_index')
    })
    this.schema.raw(`
      ALTER TABLE opportunity_activities
        ADD CONSTRAINT opportunity_activities_kind_check CHECK (kind IN ('CALL', 'EMAIL', 'MEETING', 'TASK', 'NOTE'))
    `)

    createTenantTable(this, 'campaigns', (table) => {
      table.string('name', 160).notNullable()
      table.string('channel', 10).notNullable()
      table.timestamp('starts_at', { useTz: true }).notNullable()
      table.timestamp('ends_at', { useTz: true }).nullable()
      table.decimal('budget', 19, 4).notNullable().defaultTo(0)
      table.string('currency', 3).notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
    })
    this.schema.raw(`
      ALTER TABLE campaigns
        ADD CONSTRAINT campaigns_channel_check CHECK (channel IN ('EMAIL', 'SMS', 'WHATSAPP', 'CALL', 'EVENT', 'OTHER')),
        ADD CONSTRAINT campaigns_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED')),
        ADD CONSTRAINT campaigns_budget_check CHECK (budget >= 0),
        ADD CONSTRAINT campaigns_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT campaigns_dates_check CHECK (ends_at IS NULL OR ends_at >= starts_at)
    `)

    createTenantTable(this, 'campaign_members', (table) => {
      table.uuid('campaign_id').notNullable()
      table.uuid('party_id').nullable()
      table.uuid('lead_id').nullable()
      table.string('status', 10).notNullable().defaultTo('TARGETED')
      table.timestamp('contacted_at', { useTz: true }).nullable()
      table.timestamp('responded_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'campaign_id', 'campaigns')
      tenantForeignKey(table, 'party_id', 'parties')
      tenantForeignKey(table, 'lead_id', 'leads')
      table.index(['tenant_id', 'campaign_id', 'status'], 'campaign_members_campaign_index')
    })
    this.schema.raw(`
      ALTER TABLE campaign_members
        ADD CONSTRAINT campaign_members_status_check CHECK (status IN ('TARGETED', 'CONTACTED', 'RESPONDED', 'OPTED_OUT')),
        ADD CONSTRAINT campaign_members_target_check CHECK (num_nonnulls(party_id, lead_id) = 1)
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX campaign_members_party_unique
        ON campaign_members (tenant_id, campaign_id, party_id) WHERE party_id IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX campaign_members_lead_unique
        ON campaign_members (tenant_id, campaign_id, lead_id) WHERE lead_id IS NOT NULL
    `)

    // Lista de exclusão: endereços e números a quem nunca se envia comunicação promocional.
    createTenantTable(this, 'marketing_exclusions', (table) => {
      table.string('kind', 5).notNullable()
      table.string('value', 200).notNullable()
      table.string('reason', 300).nullable()
      table.unique(['tenant_id', 'kind', 'value'], { indexName: 'marketing_exclusions_unique' })
    })
    this.schema.raw(`
      ALTER TABLE marketing_exclusions ADD CONSTRAINT marketing_exclusions_kind_check CHECK (kind IN ('EMAIL', 'PHONE'))
    `)

    // O histórico de transições nunca se altera nem se apaga.
    this.schema.raw(`
      CREATE FUNCTION crm_append_only() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'CRM_APPEND_ONLY' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER opportunity_stage_history_append_only BEFORE UPDATE OR DELETE ON opportunity_stage_history
        FOR EACH ROW EXECUTE FUNCTION crm_append_only()
    `)

    // Uma lead convertida não muda de identidade nem de destino: só os dados de contacto e o consentimento.
    this.schema.raw(`
      CREATE FUNCTION leads_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'CONVERTED' AND NEW.status = 'CONVERTED'
           AND (NEW.party_id, NEW.customer_id, NEW.opportunity_id, NEW.converted_at)
               IS NOT DISTINCT FROM (OLD.party_id, OLD.customer_id, OLD.opportunity_id, OLD.converted_at) THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'CONVERTED' THEN
          RAISE EXCEPTION 'LEAD_CONVERTED_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER leads_guard BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION leads_guard()
    `)

    for (const table of [
      'pipeline_stages',
      'leads',
      'opportunities',
      'opportunity_stage_history',
      'opportunity_activities',
      'campaigns',
      'campaign_members',
      'marketing_exclusions',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    this.schema.raw(`ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_opportunity_fk`)
    for (const table of [
      'marketing_exclusions',
      'campaign_members',
      'campaigns',
      'opportunity_activities',
      'opportunity_stage_history',
      'opportunities',
      'leads',
      'pipeline_stages',
    ]) {
      dropTable(this, table)
    }
    for (const fn of ['leads_guard', 'crm_append_only']) {
      this.schema.raw(`DROP FUNCTION IF EXISTS ${fn}()`)
    }
  }
}
