import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey, type TableBuilder } from '#database/support/tables'

/**
 * Administração empresarial (Prompt 05):
 *  - dados completos da estrutura organizacional (contactos, morada, regime fiscal, representante, responsáveis,
 *    centros de custo, função/requisitos/responsabilidades de cargos);
 *  - perfil da empresa (identidade de referência, separada da identidade fiscal de cada entidade legal);
 *  - configurações: precisões e arredondamento, convites, notificações, workflow para contas bancárias;
 *  - câmbios (por data), séries documentais (numeração sem saltos nem repetições), calendários e feriados,
 *    contas bancárias institucionais.
 * Sem cálculo fiscal nem tesouraria: são dados de referência que os módulos de negócio vão consumir.
 */
const address = (table: TableBuilder) => {
  table.string('address_line', 200).nullable()
  table.string('neighbourhood', 120).nullable()
  table.string('commune', 120).nullable()
  table.string('municipality', 120).nullable()
  table.string('province', 120).nullable()
  table.string('postal_code', 20).nullable()
}
const contacts = (table: TableBuilder) => {
  table.string('email', 254).nullable()
  table.string('phone', 40).nullable()
}

export default class extends BaseSchema {
  async up() {
    // --- Estrutura organizacional: campos novos
    this.schema.alterTable('legal_entities', (table) => {
      table.string('tax_regime', 60).nullable()
      table.boolean('vat_registered').notNullable().defaultTo(false)
      table.smallint('fiscal_year_start_month').notNullable().defaultTo(1)
      contacts(table)
      table.string('website', 200).nullable()
      address(table)
      table.string('representative_name', 160).nullable()
      table.string('representative_role', 120).nullable()
      table.check('fiscal_year_start_month BETWEEN 1 AND 12', [], 'legal_entities_fy_month_check')
    })
    this.schema.alterTable('branches', (table) => {
      contacts(table)
      address(table)
      table.uuid('manager_membership_id').nullable()
      table.uuid('cost_center_id').nullable()
      tenantForeignKey(table, 'manager_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
    })
    this.schema.alterTable('departments', (table) => {
      table.uuid('manager_membership_id').nullable()
      table.uuid('cost_center_id').nullable()
      tenantForeignKey(table, 'manager_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
    })
    this.schema.alterTable('positions', (table) => {
      table.string('job_function', 120).nullable()
      table.text('requirements').nullable()
      table.text('responsibilities').nullable()
    })
    this.schema.alterTable('cost_centers', (table) => {
      table.uuid('manager_membership_id').nullable()
      tenantForeignKey(table, 'manager_membership_id', 'tenant_memberships')
    })

    // --- Perfil da empresa (um por tenant)
    createTenantTable(this, 'tenant_profiles', (table) => {
      table.string('display_name', 160).notNullable()
      table.string('legal_name_ref', 200).nullable()
      table.string('tax_id_ref', 30).nullable()
      table.string('sector', 120).nullable()
      contacts(table)
      table.string('website', 200).nullable()
      table.specificType('country_code', 'char(2)').nullable()
      address(table)
      table.uuid('logo_attachment_id').nullable()
      tenantForeignKey(table, 'logo_attachment_id', 'attachments')
      table.unique(['tenant_id'], { indexName: 'tenant_profiles_one_per_tenant' })
    })

    // --- Configurações (uma linha por tenant)
    createTenantTable(this, 'tenant_settings', (table) => {
      table.smallint('amount_scale').notNullable().defaultTo(2)
      table.smallint('quantity_scale').notNullable().defaultTo(3)
      table.smallint('price_scale').notNullable().defaultTo(4)
      table.string('rounding_mode', 12).notNullable().defaultTo('HALF_UP')
      table.smallint('invitation_ttl_days').notNullable().defaultTo(7)
      table.boolean('notify_approval_pending').notNullable().defaultTo(true)
      table.boolean('notify_approval_decided').notNullable().defaultTo(true)
      table.uuid('bank_account_workflow_id').nullable()
      tenantForeignKey(table, 'bank_account_workflow_id', 'approval_workflows')
      table.unique(['tenant_id'], { indexName: 'tenant_settings_one_per_tenant' })
      table.check('amount_scale BETWEEN 0 AND 6', [], 'tenant_settings_amount_scale_check')
      table.check('quantity_scale BETWEEN 0 AND 6', [], 'tenant_settings_quantity_scale_check')
      table.check('price_scale BETWEEN 0 AND 8', [], 'tenant_settings_price_scale_check')
      table.check("rounding_mode IN ('HALF_UP', 'HALF_EVEN')", [], 'tenant_settings_rounding_check')
      table.check('invitation_ttl_days BETWEEN 1 AND 30', [], 'tenant_settings_ttl_check')
    })

    // --- Câmbios (por data; o mais recente até à data pedida vale)
    createTenantTable(this, 'exchange_rates', (table) => {
      table.specificType('from_currency', 'char(3)').notNullable()
      table.specificType('to_currency', 'char(3)').notNullable()
      table.decimal('rate', 24, 10).notNullable()
      table.date('valid_on').notNullable()
      table.string('source', 120).nullable()
      table.unique(['tenant_id', 'from_currency', 'to_currency', 'valid_on'], {
        indexName: 'exchange_rates_pair_date_unique',
      })
      table.check('rate > 0', [], 'exchange_rates_positive_check')
      table.check('from_currency <> to_currency', [], 'exchange_rates_distinct_check')
    })

    // --- Séries documentais
    createTenantTable(this, 'document_series', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.string('document_type', 40).notNullable()
      table.string('code', 30).notNullable()
      table.string('prefix', 20).notNullable().defaultTo('')
      table.smallint('fiscal_year').nullable()
      table.integer('next_number').notNullable().defaultTo(1)
      table.smallint('padding').notNullable().defaultTo(6)
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.date('valid_from').nullable()
      table.date('valid_to').nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      table.unique(['tenant_id', 'legal_entity_id', 'document_type', 'code'], {
        indexName: 'document_series_code_unique',
      })
      table.check('next_number >= 1', [], 'document_series_next_check')
      table.check('padding BETWEEN 1 AND 12', [], 'document_series_padding_check')
      table.check("status IN ('ACTIVE', 'CLOSED')", [], 'document_series_status_check')
      table.check(
        'valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from',
        [],
        'document_series_validity_check'
      )
    })

    // --- Calendários e feriados
    createTenantTable(this, 'calendars', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.specificType('country_code', 'char(2)').notNullable()
      table.string('province', 120).nullable()
      table.uuid('legal_entity_id').nullable()
      table.uuid('branch_id').nullable()
      table.specificType('weekend_days', 'smallint[]').notNullable().defaultTo('{6,7}')
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      table.unique(['tenant_id', 'code'], { indexName: 'calendars_code_unique' })
      table.check("status IN ('ACTIVE', 'INACTIVE')", [], 'calendars_status_check')
      table.check('weekend_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]', [], 'calendars_weekend_check')
    })
    createTenantTable(this, 'calendar_holidays', (table) => {
      table.uuid('calendar_id').notNullable()
      table.date('holiday_on').notNullable()
      table.string('name', 160).notNullable()
      table.string('kind', 12).notNullable().defaultTo('NATIONAL')
      tenantForeignKey(table, 'calendar_id', 'calendars', 'CASCADE')
      table.unique(['tenant_id', 'calendar_id', 'holiday_on'], {
        indexName: 'calendar_holidays_day_unique',
      })
      table.check("kind IN ('NATIONAL', 'REGIONAL', 'COMPANY')", [], 'calendar_holidays_kind_check')
    })

    // --- Contas bancárias institucionais
    createTenantTable(this, 'bank_accounts', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('holder_name', 200).notNullable()
      table.string('bank_name', 160).notNullable()
      table.string('iban', 34).nullable()
      table.string('account_number', 40).nullable()
      table.string('swift_bic', 11).nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.boolean('is_default').notNullable().defaultTo(false)
      table.string('status', 20).notNullable().defaultTo('ACTIVE')
      table.uuid('approval_request_id').nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'approval_request_id', 'approval_requests')
      table.check(
        "status IN ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE')",
        [],
        'bank_accounts_status_check'
      )
      table.check(
        'iban IS NOT NULL OR account_number IS NOT NULL',
        [],
        'bank_accounts_identifier_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX bank_accounts_iban_unique ON bank_accounts (tenant_id, iban)
      WHERE iban IS NOT NULL AND status <> 'REJECTED'`)
    // Uma conta por omissão por entidade legal e moeda.
    this.schema
      .raw(`CREATE UNIQUE INDEX bank_accounts_default_unique ON bank_accounts (tenant_id, legal_entity_id, currency)
      WHERE is_default AND status = 'ACTIVE'`)
  }

  async down() {
    this.schema.dropTable('bank_accounts')
    this.schema.dropTable('calendar_holidays')
    this.schema.dropTable('calendars')
    this.schema.dropTable('document_series')
    this.schema.dropTable('exchange_rates')
    this.schema.dropTable('tenant_settings')
    this.schema.dropTable('tenant_profiles')
    this.schema.alterTable('cost_centers', (table) => {
      table.dropForeign(['tenant_id', 'manager_membership_id'], 'manager_membership_id_tenant_fk')
      table.dropColumn('manager_membership_id')
    })
    this.schema.alterTable('positions', (table) => {
      table.dropColumns('job_function', 'requirements', 'responsibilities')
    })
    for (const name of ['departments', 'branches']) {
      this.schema.alterTable(name, (table) => {
        table.dropForeign(['tenant_id', 'manager_membership_id'], 'manager_membership_id_tenant_fk')
        table.dropForeign(['tenant_id', 'cost_center_id'], 'cost_center_id_tenant_fk')
        table.dropColumns('manager_membership_id', 'cost_center_id')
      })
    }
    this.schema.alterTable('branches', (table) => {
      table.dropColumns(
        'email',
        'phone',
        'address_line',
        'neighbourhood',
        'commune',
        'municipality',
        'province',
        'postal_code'
      )
    })
    this.schema.alterTable('legal_entities', (table) => {
      table.dropChecks(['legal_entities_fy_month_check'])
      table.dropColumns(
        'tax_regime',
        'vat_registered',
        'fiscal_year_start_month',
        'email',
        'phone',
        'website',
        'address_line',
        'neighbourhood',
        'commune',
        'municipality',
        'province',
        'postal_code',
        'representative_name',
        'representative_role'
      )
    })
  }
}
