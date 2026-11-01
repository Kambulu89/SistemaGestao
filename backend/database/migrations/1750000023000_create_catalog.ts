import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Catálogo (M03): categorias, produtos, variantes e tabelas de preços. O SKU identifica sempre uma variante (único por tenant);
 * um serviço nunca rastreia stock; uma tabela de preços tem moeda, validade e prioridade e os preços têm escalões de
 * quantidade. O catálogo não depende do inventário: o stock é que depende do catálogo. Nada se apaga — desactiva-se.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'product_categories', (table) => {
      table.uuid('parent_id').nullable()
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.unique(['tenant_id', 'code'], { indexName: 'product_categories_code_unique' })
    })
    // Árvore: FK composta para a própria tabela (a chave `(tenant_id, id)` só existe depois do CREATE).
    this.schema.raw(`
      ALTER TABLE product_categories
        ADD CONSTRAINT parent_id_tenant_fk FOREIGN KEY (tenant_id, parent_id)
          REFERENCES product_categories (tenant_id, id) ON DELETE RESTRICT,
        ADD CONSTRAINT product_categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
    `)

    createTenantTable(this, 'products', (table) => {
      table.string('code', 50).notNullable()
      table.string('name', 200).notNullable()
      table.string('description', 1000).nullable()
      table.string('type', 10).notNullable()
      table.uuid('category_id').nullable()
      table.uuid('base_unit_id').notNullable()
      table.boolean('track_stock').notNullable().defaultTo(false)
      table.string('tracking_mode', 10).notNullable().defaultTo('NONE')
      table.boolean('active').notNullable().defaultTo(true)
      table.string('tax_category', 50).nullable()
      tenantForeignKey(table, 'category_id', 'product_categories')
      tenantForeignKey(table, 'base_unit_id', 'units_of_measure')
      table.unique(['tenant_id', 'code'], { indexName: 'products_code_unique' })
      table.index(['tenant_id', 'category_id'], 'products_category_index')
    })
    this.schema.raw(`
      ALTER TABLE products
        ADD CONSTRAINT products_type_check CHECK (type IN ('GOODS', 'SERVICE')),
        ADD CONSTRAINT products_tracking_check CHECK (tracking_mode IN ('NONE', 'LOT', 'SERIAL')),
        -- Um serviço não movimenta nem rastreia stock; rastrear lotes ou séries exige controlar stock.
        ADD CONSTRAINT products_service_check CHECK (type = 'GOODS' OR (track_stock = false AND tracking_mode = 'NONE')),
        ADD CONSTRAINT products_tracking_stock_check CHECK (tracking_mode = 'NONE' OR track_stock = true)
    `)

    createTenantTable(this, 'product_variants', (table) => {
      table.uuid('product_id').notNullable()
      table.string('sku', 80).notNullable()
      table.string('barcode', 80).nullable()
      table.jsonb('attributes').notNullable().defaultTo('{}')
      table.boolean('active').notNullable().defaultTo(true)
      table.boolean('is_default').notNullable().defaultTo(false)
      tenantForeignKey(table, 'product_id', 'products')
      table.unique(['tenant_id', 'sku'], { indexName: 'product_variants_sku_unique' })
      table.index(['tenant_id', 'product_id'], 'product_variants_product_index')
    })
    this.schema.raw(`
      ALTER TABLE product_variants
        ADD CONSTRAINT product_variants_attributes_check CHECK (jsonb_typeof(attributes) = 'object')
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX product_variants_barcode_unique ON product_variants (tenant_id, barcode)
        WHERE barcode IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX product_variants_one_default ON product_variants (tenant_id, product_id)
        WHERE is_default
    `)

    createTenantTable(this, 'price_lists', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('name', 160).notNullable()
      table.string('currency', 3).notNullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.boolean('tax_inclusive').notNullable().defaultTo(false)
      table.integer('priority').notNullable().defaultTo(0)
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.unique(['tenant_id', 'organization_id', 'name'], {
        indexName: 'price_lists_name_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE price_lists
        ADD CONSTRAINT price_lists_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT price_lists_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
        ADD CONSTRAINT price_lists_priority_check CHECK (priority BETWEEN -1000 AND 1000)
    `)

    createTenantTable(this, 'price_list_items', (table) => {
      table.uuid('price_list_id').notNullable()
      table.uuid('variant_id').notNullable()
      table.decimal('min_quantity', 19, 6).notNullable().defaultTo(1)
      table.decimal('unit_price', 19, 4).notNullable()
      table.decimal('max_discount', 5, 4).notNullable().defaultTo(0)
      tenantForeignKey(table, 'price_list_id', 'price_lists')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.unique(['tenant_id', 'price_list_id', 'variant_id', 'min_quantity'], {
        indexName: 'price_list_items_tier_unique',
      })
      table.index(['tenant_id', 'variant_id'], 'price_list_items_variant_index')
    })
    this.schema.raw(`
      ALTER TABLE price_list_items
        ADD CONSTRAINT price_list_items_quantity_check CHECK (min_quantity > 0),
        ADD CONSTRAINT price_list_items_price_check CHECK (unit_price >= 0),
        ADD CONSTRAINT price_list_items_discount_check CHECK (max_discount >= 0 AND max_discount <= 1)
    `)

    for (const table of [
      'product_categories',
      'products',
      'product_variants',
      'price_lists',
      'price_list_items',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    dropTable(this, 'price_list_items')
    dropTable(this, 'price_lists')
    dropTable(this, 'product_variants')
    dropTable(this, 'products')
    dropTable(this, 'product_categories')
  }
}
