import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Inventário (M07). O **livro de movimentos** é a verdade: só se acrescenta (nem SQL directo o altera) e cada movimento
 * tem uma origem única (tipo/documento/linha/efeito), por isso repetir um comando não duplica o efeito. O saldo
 * (`stock_balances`) é derivado e actualiza-se na mesma transacção do movimento, sob bloqueio da linha; nunca é um campo
 * editável pela API. `NULL` no lote é uma dimensão explícita da chave (índice sobre `coalesce`). A valorização é o custo
 * médio móvel por variante e armazém (`stock_costs`).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'warehouses', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('code', 40).notNullable()
      table.string('name', 160).notNullable()
      table.boolean('allow_negative').notNullable().defaultTo(false)
      table.boolean('allow_backorder').notNullable().defaultTo(false)
      table.boolean('sales_default').notNullable().defaultTo(false)
      table.boolean('active').notNullable().defaultTo(true)
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.unique(['tenant_id', 'organization_id', 'code'], {
        indexName: 'warehouses_code_unique',
      })
    })
    // Um só armazém «de vendas» por organização: é onde a confirmação de encomendas verifica e reserva stock.
    this.schema.raw(`
      CREATE UNIQUE INDEX warehouses_sales_default_unique ON warehouses (tenant_id, organization_id)
        WHERE sales_default
    `)

    createTenantTable(this, 'stock_locations', (table) => {
      table.uuid('warehouse_id').notNullable()
      table.string('code', 40).notNullable()
      table.string('name', 160).notNullable()
      table.boolean('active').notNullable().defaultTo(true)
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      table.unique(['tenant_id', 'warehouse_id', 'code'], {
        indexName: 'stock_locations_code_unique',
      })
    })

    createTenantTable(this, 'lots', (table) => {
      table.uuid('variant_id').notNullable()
      table.string('code', 60).notNullable()
      table.date('manufactured_on').nullable()
      table.date('expires_on').nullable()
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.unique(['tenant_id', 'variant_id', 'code'], { indexName: 'lots_code_unique' })
    })
    this.schema.raw(`
      ALTER TABLE lots ADD CONSTRAINT lots_dates_check
        CHECK (manufactured_on IS NULL OR expires_on IS NULL OR expires_on >= manufactured_on)
    `)

    createTenantTable(this, 'stock_balances', (table) => {
      table.uuid('variant_id').notNullable()
      table.uuid('location_id').notNullable()
      table.uuid('lot_id').nullable()
      table.decimal('on_hand', 19, 6).notNullable().defaultTo(0)
      table.decimal('reserved', 19, 6).notNullable().defaultTo(0)
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'location_id', 'stock_locations')
      tenantForeignKey(table, 'lot_id', 'lots')
      table.index(['tenant_id', 'variant_id'], 'stock_balances_variant_index')
    })
    this.schema.raw(`
      ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_reserved_check CHECK (reserved >= 0)
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX stock_balances_key_unique ON stock_balances
        (tenant_id, variant_id, location_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid))
    `)

    createTenantTable(this, 'stock_movements', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('variant_id').notNullable()
      table.uuid('location_id').notNullable()
      table.uuid('lot_id').nullable()
      table.decimal('quantity_delta', 19, 6).notNullable()
      table.decimal('unit_cost', 19, 4).notNullable().defaultTo(0)
      table.string('source_type', 40).notNullable()
      table.uuid('source_id').notNullable()
      table.uuid('source_line_id').nullable()
      table.string('effect', 20).notNullable().defaultTo('MAIN')
      table.string('movement_kind', 14).notNullable()
      table.uuid('reversed_movement_id').nullable()
      table.string('reason', 300).nullable()
      table.timestamp('posted_at', { useTz: true }).notNullable().defaultTo(this.now())
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'location_id', 'stock_locations')
      tenantForeignKey(table, 'lot_id', 'lots')
      table.index(['tenant_id', 'variant_id', 'posted_at'], 'stock_movements_variant_index')
      table.index(['tenant_id', 'location_id', 'posted_at'], 'stock_movements_location_index')
    })
    this.schema.raw(`
      ALTER TABLE stock_movements
        ADD CONSTRAINT stock_movements_reversed_fk FOREIGN KEY (tenant_id, reversed_movement_id)
          REFERENCES stock_movements (tenant_id, id) ON DELETE RESTRICT,
        ADD CONSTRAINT stock_movements_delta_check CHECK (quantity_delta <> 0),
        ADD CONSTRAINT stock_movements_cost_check CHECK (unit_cost >= 0),
        ADD CONSTRAINT stock_movements_kind_check CHECK (movement_kind IN
          ('RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'REVERSAL')),
        ADD CONSTRAINT stock_movements_sign_check CHECK (
          (movement_kind IN ('RECEIPT', 'TRANSFER_IN') AND quantity_delta > 0)
          OR (movement_kind IN ('ISSUE', 'TRANSFER_OUT') AND quantity_delta < 0)
          OR movement_kind IN ('ADJUSTMENT', 'REVERSAL')),
        ADD CONSTRAINT stock_movements_reversal_check
          CHECK ((movement_kind = 'REVERSAL') = (reversed_movement_id IS NOT NULL))
    `)
    // Origem única por tipo/documento/linha/efeito: repetir o comando devolve o movimento já lançado.
    this.schema.raw(`
      CREATE UNIQUE INDEX stock_movements_source_unique ON stock_movements
        (tenant_id, source_type, source_id, coalesce(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid), effect)
    `)
    // Um movimento só se reverte uma vez.
    this.schema.raw(`
      CREATE UNIQUE INDEX stock_movements_reversal_unique ON stock_movements (tenant_id, reversed_movement_id)
        WHERE reversed_movement_id IS NOT NULL
    `)
    this.schema.raw(`
      CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
        FOR EACH ROW EXECUTE FUNCTION audit_forbid_change()
    `)

    createTenantTable(this, 'stock_costs', (table) => {
      table.uuid('warehouse_id').notNullable()
      table.uuid('variant_id').notNullable()
      table.decimal('quantity', 19, 6).notNullable().defaultTo(0)
      table.decimal('avg_cost', 19, 4).notNullable().defaultTo(0)
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.unique(['tenant_id', 'warehouse_id', 'variant_id'], {
        indexName: 'stock_costs_key_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE stock_costs ADD CONSTRAINT stock_costs_cost_check CHECK (avg_cost >= 0)
    `)

    createTenantTable(this, 'stock_reservations', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('variant_id').notNullable()
      table.uuid('location_id').notNullable()
      table.uuid('lot_id').nullable()
      table.string('source_type', 40).notNullable()
      table.uuid('source_id').notNullable()
      table.uuid('source_line_id').nullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.decimal('consumed_qty', 19, 6).notNullable().defaultTo(0)
      table.decimal('released_qty', 19, 6).notNullable().defaultTo(0)
      table.timestamp('expires_at', { useTz: true }).nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'location_id', 'stock_locations')
      tenantForeignKey(table, 'lot_id', 'lots')
      table.index(['tenant_id', 'source_type', 'source_id'], 'stock_reservations_source_index')
      table.index(['tenant_id', 'status'], 'stock_reservations_status_index')
    })
    this.schema.raw(`
      ALTER TABLE stock_reservations
        ADD CONSTRAINT stock_reservations_quantity_check CHECK (quantity > 0),
        ADD CONSTRAINT stock_reservations_parts_check
          CHECK (consumed_qty >= 0 AND released_qty >= 0 AND consumed_qty + released_qty <= quantity),
        ADD CONSTRAINT stock_reservations_status_check
          CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED')),
        ADD CONSTRAINT stock_reservations_closed_check
          CHECK ((status = 'ACTIVE') = (consumed_qty + released_qty < quantity))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX stock_reservations_source_unique ON stock_reservations
        (tenant_id, source_type, source_id, coalesce(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid),
         location_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid))
    `)

    auditTable(this, 'warehouses')
    auditTable(this, 'stock_locations')
    auditTable(this, 'lots')
    auditTable(this, 'stock_balances')
    auditTable(this, 'stock_movements')
    auditTable(this, 'stock_costs')
    auditTable(this, 'stock_reservations')
  }

  async down() {
    dropTable(this, 'stock_reservations')
    dropTable(this, 'stock_costs')
    dropTable(this, 'stock_movements')
    dropTable(this, 'stock_balances')
    dropTable(this, 'lots')
    dropTable(this, 'stock_locations')
    dropTable(this, 'warehouses')
  }
}
