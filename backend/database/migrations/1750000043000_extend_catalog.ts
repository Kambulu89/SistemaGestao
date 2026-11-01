import { BaseSchema } from '@adonisjs/lucid/schema'
import { auditTable, createTenantTable, dropTable } from '#database/support/tenant_tables'

/**
 * Inventário (Prompt 08, bloco 8.1): o catálogo existente (M03) passa a ter marcas, classificação da finalidade do
 * artigo, dados logísticos e a política física de expedição — sem criar um segundo «produto». Migração só aditiva:
 * colunas novas com valores por omissão que mantêm os produtos actuais válidos.
 *
 *  - `type` (GOODS/SERVICE) continua a dizer se é bem físico; `item_kind` diz a finalidade (matéria-prima, acabado…).
 *  - `picking_policy` é a ordem FÍSICA de expedição (FIFO/FEFO/manual). Não é o método contabilístico de valorização.
 *  - FEFO e o controlo de validade exigem rastreio por lote (a validade vive no lote).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'product_brands', (table) => {
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.text('description').nullable()
      table.specificType('country_code', 'char(2)').nullable()
      table.boolean('active').notNullable().defaultTo(true)
      table.unique(['tenant_id', 'code'], { indexName: 'product_brands_code_unique' })
      table.check(
        "country_code IS NULL OR country_code ~ '^[A-Z]{2}$'",
        [],
        'product_brands_country_check'
      )
    })
    auditTable(this, 'product_brands')

    this.schema.raw(`
      ALTER TABLE products
        ADD COLUMN brand_id uuid NULL,
        ADD COLUMN short_name varchar(60) NULL,
        ADD COLUMN model varchar(80) NULL,
        ADD COLUMN item_kind text NOT NULL DEFAULT 'GENERAL',
        ADD COLUMN purchasable boolean NOT NULL DEFAULT true,
        ADD COLUMN sellable boolean NOT NULL DEFAULT true,
        ADD COLUMN tracks_expiry boolean NOT NULL DEFAULT false,
        ADD COLUMN picking_policy text NOT NULL DEFAULT 'FIFO',
        ADD COLUMN weight_kg numeric(19,6) NULL,
        ADD COLUMN length_m numeric(19,6) NULL,
        ADD COLUMN width_m numeric(19,6) NULL,
        ADD COLUMN height_m numeric(19,6) NULL,
        ADD COLUMN lead_time_days integer NULL,
        ADD CONSTRAINT brand_id_tenant_fk FOREIGN KEY (tenant_id, brand_id)
          REFERENCES product_brands (tenant_id, id) ON DELETE RESTRICT,
        ADD CONSTRAINT products_item_kind_check CHECK (item_kind IN
          ('GENERAL', 'RAW_MATERIAL', 'FINISHED_GOOD', 'CONSUMABLE', 'MAINTENANCE', 'SERVICE')),
        ADD CONSTRAINT products_item_kind_service_check CHECK ((type = 'SERVICE') = (item_kind = 'SERVICE')),
        ADD CONSTRAINT products_picking_policy_check CHECK (picking_policy IN ('FIFO', 'FEFO', 'MANUAL')),
        ADD CONSTRAINT products_expiry_needs_lot_check CHECK (tracks_expiry = false OR tracking_mode = 'LOT'),
        ADD CONSTRAINT products_fefo_needs_expiry_check CHECK (picking_policy <> 'FEFO' OR tracks_expiry),
        ADD CONSTRAINT products_dimensions_check CHECK (
          coalesce(weight_kg, 0) >= 0 AND coalesce(length_m, 0) >= 0
          AND coalesce(width_m, 0) >= 0 AND coalesce(height_m, 0) >= 0),
        ADD CONSTRAINT products_lead_time_check CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650)
    `)
    // Os serviços existentes passam a ter a finalidade coerente com o tipo.
    this.schema.raw(`UPDATE products SET item_kind = 'SERVICE' WHERE type = 'SERVICE'`)
    this.schema.raw(`CREATE INDEX products_brand_index ON products (tenant_id, brand_id)`)

    this.schema.raw(`
      ALTER TABLE product_categories
        ADD COLUMN description text NULL,
        ADD COLUMN active boolean NOT NULL DEFAULT true
    `)
  }

  async down() {
    this.schema.raw(`ALTER TABLE product_categories DROP COLUMN active, DROP COLUMN description`)
    this.schema.raw(`DROP INDEX products_brand_index`)
    this.schema.raw(`
      ALTER TABLE products
        DROP CONSTRAINT products_lead_time_check,
        DROP CONSTRAINT products_dimensions_check,
        DROP CONSTRAINT products_fefo_needs_expiry_check,
        DROP CONSTRAINT products_expiry_needs_lot_check,
        DROP CONSTRAINT products_picking_policy_check,
        DROP CONSTRAINT products_item_kind_service_check,
        DROP CONSTRAINT products_item_kind_check,
        DROP CONSTRAINT brand_id_tenant_fk,
        DROP COLUMN lead_time_days, DROP COLUMN height_m, DROP COLUMN width_m, DROP COLUMN length_m,
        DROP COLUMN weight_kg, DROP COLUMN picking_policy, DROP COLUMN tracks_expiry, DROP COLUMN sellable,
        DROP COLUMN purchasable, DROP COLUMN item_kind, DROP COLUMN model, DROP COLUMN short_name,
        DROP COLUMN brand_id
    `)
    dropTable(this, 'product_brands')
  }
}
