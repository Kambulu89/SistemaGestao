import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Catálogo de produtos e serviços (Prompt 08, bloco 8.1). O Inventário é o dono destes cadastros.
 *
 *  - `uoms`: unidades de medida da empresa (com casas decimais permitidas).
 *  - `product_categories` (hierarquia) com a classe contabilística por omissão; `brands`.
 *  - `products`: SKU, código de barras, tipo (armazenável, serviço, kit), unidades base/compra/venda, rastreio por lote,
 *    série e validade, stock mínimo/máximo, preço comercial e classe contabilística (sobrepõe a da categoria).
 *    Serviços e kits não têm rastreio nem limites de stock (não movimentam stock).
 *  - `product_variants`: variantes com SKU, código de barras e atributos próprios.
 *  - `product_uom_conversions`: quantas unidades base tem 1 unidade alternativa do produto.
 *  - `product_kit_components`: componentes armazenáveis de um kit, em unidades base do componente.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'uoms', (table) => {
      table.string('code', 12).notNullable()
      table.string('name', 60).notNullable()
      table.string('category', 10).notNullable()
      table.smallint('decimals').notNullable().defaultTo(0)
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'uoms_code_unique' })
      table.check(
        `category IN ('UNIT','WEIGHT','VOLUME','LENGTH','AREA','TIME','OTHER')`,
        [],
        'uoms_category_check'
      )
      table.check('decimals BETWEEN 0 AND 6', [], 'uoms_decimals_check')
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'uoms_status_check')
    })

    createTenantTable(this, 'product_categories', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.uuid('parent_id').nullable()
      table.string('accounting_class', 30).nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.index(['tenant_id', 'parent_id'], 'product_categories_parent_index')
      table.unique(['tenant_id', 'code'], { indexName: 'product_categories_code_unique' })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'product_categories_status_check')
      table.check('parent_id IS NULL OR parent_id <> id', [], 'product_categories_parent_check')
    })

    this.schema.raw(`ALTER TABLE product_categories ADD CONSTRAINT product_categories_parent_fk
      FOREIGN KEY (tenant_id, parent_id) REFERENCES product_categories (tenant_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'brands', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'brands_code_unique' })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'brands_status_check')
    })

    createTenantTable(this, 'products', (table) => {
      table.string('sku', 40).notNullable()
      table.string('barcode', 48).nullable()
      table.string('name', 200).notNullable()
      table.text('description').nullable()
      table.string('product_type', 10).notNullable()
      table.uuid('category_id').nullable()
      table.uuid('brand_id').nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.uuid('base_uom_id').notNullable()
      table.uuid('purchase_uom_id').nullable()
      table.uuid('sale_uom_id').nullable()
      table.boolean('track_lots').notNullable().defaultTo(false)
      table.boolean('track_serials').notNullable().defaultTo(false)
      table.boolean('track_expiry').notNullable().defaultTo(false)
      table.integer('shelf_life_days').nullable()
      table.decimal('min_stock', 18, 6).nullable()
      table.decimal('max_stock', 18, 6).nullable()
      table.string('currency', 3).nullable()
      table.decimal('sale_price', 18, 4).nullable()
      table.string('accounting_class', 30).nullable()
      table.boolean('has_variants').notNullable().defaultTo(false)
      tenantForeignKey(table, 'category_id', 'product_categories')
      tenantForeignKey(table, 'brand_id', 'brands')
      tenantForeignKey(table, 'base_uom_id', 'uoms')
      tenantForeignKey(table, 'purchase_uom_id', 'uoms')
      tenantForeignKey(table, 'sale_uom_id', 'uoms')
      table.unique(['tenant_id', 'sku'], { indexName: 'products_sku_unique' })
      table.index(['tenant_id', 'category_id'], 'products_category_index')
      table.check(`product_type IN ('STOCKABLE','SERVICE','KIT')`, [], 'products_type_check')
      table.check(`status IN ('ACTIVE','INACTIVE','DISCONTINUED')`, [], 'products_status_check')
      // Serviços e kits não movimentam stock: sem rastreio nem limites.
      table.check(
        `product_type = 'STOCKABLE' OR (NOT track_lots AND NOT track_serials AND NOT track_expiry
          AND min_stock IS NULL AND max_stock IS NULL AND shelf_life_days IS NULL)`,
        [],
        'products_non_stock_check'
      )
      table.check(
        'shelf_life_days IS NULL OR (track_expiry AND shelf_life_days BETWEEN 1 AND 36500)',
        [],
        'products_shelf_life_check'
      )
      table.check(
        '(min_stock IS NULL OR min_stock >= 0) AND (max_stock IS NULL OR max_stock > 0) AND (min_stock IS NULL OR max_stock IS NULL OR min_stock <= max_stock)',
        [],
        'products_stock_limits_check'
      )
      table.check(
        '(sale_price IS NULL) = (currency IS NULL) AND (sale_price IS NULL OR sale_price >= 0)',
        [],
        'products_price_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX products_barcode_unique ON products (tenant_id, barcode)
      WHERE barcode IS NOT NULL`)

    createTenantTable(this, 'product_variants', (table) => {
      table.uuid('product_id').notNullable()
      table.string('sku', 40).notNullable()
      table.string('barcode', 48).nullable()
      table.jsonb('attributes').notNullable()
      table.decimal('sale_price', 18, 4).nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'product_id', 'products', 'CASCADE')
      table.unique(['tenant_id', 'sku'], { indexName: 'product_variants_sku_unique' })
      table.index(['tenant_id', 'product_id'], 'product_variants_product_index')
      table.check(
        `status IN ('ACTIVE','INACTIVE','DISCONTINUED')`,
        [],
        'product_variants_status_check'
      )
      table.check('sale_price IS NULL OR sale_price >= 0', [], 'product_variants_price_check')
      table.check(
        `jsonb_typeof(attributes) = 'object' AND attributes <> '{}'::jsonb`,
        [],
        'product_variants_attributes_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX product_variants_barcode_unique ON product_variants (tenant_id, barcode)
      WHERE barcode IS NOT NULL`)

    createTenantTable(this, 'product_uom_conversions', (table) => {
      table.uuid('product_id').notNullable()
      table.uuid('uom_id').notNullable()
      table.decimal('factor', 18, 6).notNullable()
      tenantForeignKey(table, 'product_id', 'products', 'CASCADE')
      tenantForeignKey(table, 'uom_id', 'uoms')
      table.unique(['tenant_id', 'product_id', 'uom_id'], {
        indexName: 'product_uom_conversions_unique',
      })
      table.check('factor > 0', [], 'product_uom_conversions_factor_check')
    })

    createTenantTable(this, 'product_kit_components', (table) => {
      table.uuid('kit_id').notNullable()
      table.uuid('component_id').notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      tenantForeignKey(table, 'kit_id', 'products', 'CASCADE')
      tenantForeignKey(table, 'component_id', 'products')
      table.unique(['tenant_id', 'kit_id', 'component_id'], {
        indexName: 'product_kit_components_unique',
      })
      table.check('quantity > 0', [], 'product_kit_components_quantity_check')
      table.check('kit_id <> component_id', [], 'product_kit_components_self_check')
    })
  }

  async down() {
    this.schema.dropTable('product_kit_components')
    this.schema.dropTable('product_uom_conversions')
    this.schema.dropTable('product_variants')
    this.schema.dropTable('products')
    this.schema.dropTable('brands')
    this.schema.dropTable('product_categories')
    this.schema.dropTable('uoms')
  }
}
