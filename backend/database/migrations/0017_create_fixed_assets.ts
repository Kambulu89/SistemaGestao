import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Activos fixos (Prompt 06, bloco 6.6). As classes dizem as contas e o diário; cada ficha guarda aquisição,
 * localização, vida útil, residual e método. Os lançamentos (aquisição, depreciação, abate) são lançamentos normais
 * do razão, gerados pelo módulo; as tabelas daqui só os referenciam. Duplicados bloqueados pela base de dados:
 * n.º de inventário e n.º de série por entidade, e uma depreciação por activo e mês.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'fixed_asset_classes', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('method', 20).notNullable().defaultTo('STRAIGHT_LINE')
      table.integer('useful_life_months').notNullable()
      table.specificType('declining_factor', 'numeric(4,2)').nullable()
      table.uuid('journal_id').notNullable()
      table.uuid('asset_account_id').notNullable()
      table.uuid('accumulated_account_id').notNullable()
      table.uuid('expense_account_id').notNullable()
      table.uuid('gain_account_id').notNullable()
      table.uuid('loss_account_id').notNullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'journal_id', 'journals')
      for (const c of [
        'asset_account_id',
        'accumulated_account_id',
        'expense_account_id',
        'gain_account_id',
        'loss_account_id',
      ])
        tenantForeignKey(table, c, 'accounts')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], {
        indexName: 'fixed_asset_classes_code_unique',
      })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'fixed_asset_classes_status_check')
      table.check(
        `method IN ('STRAIGHT_LINE','DECLINING_BALANCE')`,
        [],
        'fixed_asset_classes_method_check'
      )
      table.check('useful_life_months BETWEEN 1 AND 1200', [], 'fixed_asset_classes_life_check')
    })

    createTenantTable(this, 'fixed_assets', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('class_id').notNullable()
      table.string('number', 30).notNullable()
      table.string('name', 160).notNullable()
      table.text('description').nullable()
      table.string('serial_number', 80).nullable()
      table.string('supplier_name', 160).nullable()
      table.string('acquisition_document', 60).nullable()
      table.date('acquisition_date').notNullable()
      table.specificType('cost', 'numeric(20,6)').notNullable()
      table.specificType('residual_value', 'numeric(20,6)').notNullable().defaultTo(0)
      table.integer('useful_life_months').notNullable()
      table.string('method', 20).notNullable()
      table.specificType('declining_factor', 'numeric(4,2)').nullable()
      table.date('depreciation_start').notNullable()
      table.string('location', 160).nullable()
      table.uuid('cost_center_id').nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.uuid('acquisition_entry_id').nullable()
      table.date('disposal_date').nullable()
      table.specificType('disposal_proceeds', 'numeric(20,6)').nullable()
      table.string('disposal_reason', 300).nullable()
      table.uuid('disposal_entry_id').nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'class_id', 'fixed_asset_classes')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'acquisition_entry_id', 'journal_entries')
      tenantForeignKey(table, 'disposal_entry_id', 'journal_entries')
      table.unique(['tenant_id', 'legal_entity_id', 'number'], {
        indexName: 'fixed_assets_number_unique',
      })
      table.check(`status IN ('DRAFT','ACTIVE','DISPOSED')`, [], 'fixed_assets_status_check')
      table.check(
        `method IN ('STRAIGHT_LINE','DECLINING_BALANCE')`,
        [],
        'fixed_assets_method_check'
      )
      table.check(
        'cost > 0 AND residual_value >= 0 AND residual_value < cost',
        [],
        'fixed_assets_values_check'
      )
      table.check('useful_life_months BETWEEN 1 AND 1200', [], 'fixed_assets_life_check')
      table.check(`extract(day from depreciation_start) = 1`, [], 'fixed_assets_start_month_check')
      // Activo activo tem aquisição contabilizada; abatido tem abate contabilizado.
      table.check(
        `(status = 'DRAFT' OR acquisition_entry_id IS NOT NULL) AND (status <> 'DISPOSED' OR disposal_entry_id IS NOT NULL)`,
        [],
        'fixed_assets_entries_check'
      )
    })
    this.schema.raw(
      `CREATE UNIQUE INDEX fixed_assets_serial_unique ON fixed_assets (tenant_id, legal_entity_id, lower(serial_number))
        WHERE serial_number IS NOT NULL`
    )
    this.schema.raw(
      'CREATE INDEX fixed_assets_class_index ON fixed_assets (tenant_id, class_id, status)'
    )

    createTenantTable(this, 'fixed_asset_depreciations', (table) => {
      table.uuid('asset_id').notNullable()
      table.date('month').notNullable()
      table.specificType('amount', 'numeric(20,6)').notNullable()
      table.uuid('cost_center_id').nullable()
      table.uuid('entry_id').notNullable()
      tenantForeignKey(table, 'asset_id', 'fixed_assets')
      tenantForeignKey(table, 'entry_id', 'journal_entries')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      // Bloqueio de duplicados: um mês só se deprecia uma vez por activo.
      table.unique(['tenant_id', 'asset_id', 'month'], {
        indexName: 'fixed_asset_depreciations_month_unique',
      })
      table.check('amount > 0', [], 'fixed_asset_depreciations_amount_check')
      table.check(`extract(day from month) = 1`, [], 'fixed_asset_depreciations_month_check')
    })
    this.schema.raw(
      'CREATE INDEX fixed_asset_depreciations_entry_index ON fixed_asset_depreciations (tenant_id, entry_id)'
    )

    createTenantTable(this, 'fixed_asset_movements', (table) => {
      table.uuid('asset_id').notNullable()
      table.string('type', 20).notNullable()
      table.date('movement_date').notNullable()
      table.string('from_location', 160).nullable()
      table.string('to_location', 160).nullable()
      table.uuid('from_cost_center_id').nullable()
      table.uuid('to_cost_center_id').nullable()
      table.uuid('entry_id').nullable()
      table.string('notes', 300).nullable()
      tenantForeignKey(table, 'asset_id', 'fixed_assets')
      tenantForeignKey(table, 'from_cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'to_cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'entry_id', 'journal_entries')
      table.check(
        `type IN ('ACQUISITION','TRANSFER','DISPOSAL','ACQUISITION_REVERSED','DISPOSAL_REVERSED')`,
        [],
        'fixed_asset_movements_type_check'
      )
    })
    this.schema.raw(
      'CREATE INDEX fixed_asset_movements_asset_index ON fixed_asset_movements (tenant_id, asset_id, movement_date)'
    )
  }

  async down() {
    this.schema.dropTable('fixed_asset_movements')
    this.schema.dropTable('fixed_asset_depreciations')
    this.schema.dropTable('fixed_assets')
    this.schema.dropTable('fixed_asset_classes')
  }
}
