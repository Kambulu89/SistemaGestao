import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Lotes, séries e FEFO (Prompt 08, bloco 8.8).
 *
 *  - `stock_lots`: lote de um produto/variante (código único por produto/variante), validade e fabrico, estado
 *    (activo, bloqueado, recolhido) com motivos.
 *  - `stock_lot_events`: bloqueios, desbloqueios e recolhas, com o lançamento de stock que mudou o estado do stock.
 *    Só acréscimo.
 *  - O lote passa a ser uma dimensão de `stock_movements` e `stock_balances` (só nos baldes físicos e em trânsito; o
 *    reservado e o previsto contam-se sem lote).
 *  - `stock_serials`: cada unidade com número de série — onde está (armazém, localização, lote, balde) ou fora do
 *    stock — e `stock_serial_movements`, o histórico por lançamento. Só acréscimo.
 *  - `stock_count_lines` ganha o lote (a contagem é por saldo, e o saldo é por lote).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'stock_lots', (table) => {
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.string('code', 40).notNullable()
      table.date('expiry_date').nullable()
      table.date('manufactured_date').nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.string('block_reason', 300).nullable()
      table.string('recall_reason', 300).nullable()
      table.timestamp('recalled_at', { useTz: true }).nullable()
      table.uuid('recalled_by').nullable()
      tenantForeignKey(table, 'product_id', 'products')
      table.index(['tenant_id', 'product_id', 'expiry_date'], 'stock_lots_fefo_index')
      table.check(`status IN ('ACTIVE','BLOCKED','RECALLED')`, [], 'stock_lots_status_check')
      table.check(`(status = 'BLOCKED') = (block_reason IS NOT NULL)`, [], 'stock_lots_block_check')
      table.check(
        `(status = 'RECALLED') = (recall_reason IS NOT NULL AND recalled_at IS NOT NULL)`,
        [],
        'stock_lots_recall_check'
      )
      table.check(
        'manufactured_date IS NULL OR expiry_date IS NULL OR manufactured_date <= expiry_date',
        [],
        'stock_lots_dates_check'
      )
    })
    this.schema.raw(`ALTER TABLE stock_lots ADD CONSTRAINT stock_lots_code_unique
      UNIQUE NULLS NOT DISTINCT (tenant_id, product_id, variant_id, code)`)
    this.schema.raw(`ALTER TABLE stock_lots ADD CONSTRAINT stock_lots_product_id_unique
      UNIQUE (tenant_id, product_id, id)`)
    this.schema.raw(`ALTER TABLE stock_lots ADD CONSTRAINT stock_lots_variant_fk
      FOREIGN KEY (tenant_id, product_id, variant_id) REFERENCES product_variants (tenant_id, product_id, id)
      ON DELETE RESTRICT`)
    // Um lote recolhido não volta atrás; o código, o produto e a validade não mudam.
    this.schema.raw(`
      CREATE FUNCTION stock_lots_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.product_id IS DISTINCT FROM OLD.product_id
           OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.code IS DISTINCT FROM OLD.code
           OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date
           OR (OLD.status = 'RECALLED' AND NEW.status IS DISTINCT FROM 'RECALLED') THEN
          RAISE EXCEPTION 'LOT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER stock_lots_fixed BEFORE UPDATE OR DELETE ON stock_lots
      FOR EACH ROW EXECUTE FUNCTION stock_lots_fixed()`)

    createTenantTable(this, 'stock_lot_events', (table) => {
      table.uuid('lot_id').notNullable()
      table.string('kind', 10).notNullable()
      table.string('reason', 300).notNullable()
      table.uuid('posting_id').nullable()
      tenantForeignKey(table, 'lot_id', 'stock_lots')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      table.index(['tenant_id', 'lot_id'], 'stock_lot_events_lot_index')
      table.check(`kind IN ('BLOCKED','UNBLOCKED','RECALLED')`, [], 'stock_lot_events_kind_check')
    })

    // Lote nos movimentos e nos saldos.
    for (const t of ['stock_movements', 'stock_balances']) {
      this.schema.raw(`ALTER TABLE ${t} ADD COLUMN lot_id uuid NULL`)
      this.schema.raw(`ALTER TABLE ${t} ADD CONSTRAINT ${t}_lot_fk
        FOREIGN KEY (tenant_id, product_id, lot_id) REFERENCES stock_lots (tenant_id, product_id, id)
        ON DELETE RESTRICT`)
    }
    this.schema.raw(`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_lot_bucket_check
      CHECK (lot_id IS NULL OR bucket IN ('UNRESTRICTED','BLOCKED','QUARANTINE','IN_TRANSIT'))`)
    this.schema.raw(`CREATE INDEX stock_movements_lot_index ON stock_movements (tenant_id, lot_id)
      WHERE lot_id IS NOT NULL`)
    this.schema.raw('ALTER TABLE stock_balances DROP CONSTRAINT stock_balances_key_unique')
    this.schema.raw(`ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_key_unique
      UNIQUE NULLS NOT DISTINCT (tenant_id, warehouse_id, location_id, product_id, variant_id, lot_id)`)
    this.schema.raw(`CREATE INDEX stock_balances_lot_index ON stock_balances (tenant_id, lot_id)
      WHERE lot_id IS NOT NULL`)
    this.schema.raw(`
      CREATE OR REPLACE FUNCTION stock_movements_apply() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        u numeric := CASE WHEN NEW.bucket = 'UNRESTRICTED' THEN NEW.quantity ELSE 0 END;
        b numeric := CASE WHEN NEW.bucket = 'BLOCKED' THEN NEW.quantity ELSE 0 END;
        q numeric := CASE WHEN NEW.bucket = 'QUARANTINE' THEN NEW.quantity ELSE 0 END;
        r numeric := CASE WHEN NEW.bucket = 'RESERVED' THEN NEW.quantity ELSE 0 END;
        t numeric := CASE WHEN NEW.bucket = 'IN_TRANSIT' THEN NEW.quantity ELSE 0 END;
        e numeric := CASE WHEN NEW.bucket = 'EXPECTED' THEN NEW.quantity ELSE 0 END;
      BEGIN
        LOOP
          UPDATE stock_balances SET
            qty_unrestricted = qty_unrestricted + u,
            qty_blocked = qty_blocked + b,
            qty_quarantine = qty_quarantine + q,
            qty_reserved = qty_reserved + r,
            qty_in_transit = qty_in_transit + t,
            qty_expected = qty_expected + e,
            last_movement_at = NEW.occurred_at,
            updated_at = now(),
            updated_by = NEW.created_by,
            version = version + 1
          WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id AND product_id = NEW.product_id
            AND location_id IS NOT DISTINCT FROM NEW.location_id AND variant_id IS NOT DISTINCT FROM NEW.variant_id
            AND lot_id IS NOT DISTINCT FROM NEW.lot_id;
          EXIT WHEN FOUND;
          BEGIN
            INSERT INTO stock_balances (tenant_id, warehouse_id, location_id, product_id, variant_id, lot_id,
                qty_unrestricted, qty_blocked, qty_quarantine, qty_reserved, qty_in_transit, qty_expected,
                last_movement_at, created_by, updated_by)
              VALUES (NEW.tenant_id, NEW.warehouse_id, NEW.location_id, NEW.product_id, NEW.variant_id, NEW.lot_id,
                u, b, q, r, t, e, NEW.occurred_at, NEW.created_by, NEW.created_by);
            EXIT;
          EXCEPTION WHEN unique_violation THEN
          END;
        END LOOP;
        RETURN NULL;
      END $$`)

    createTenantTable(this, 'stock_serials', (table) => {
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.string('serial', 80).notNullable()
      table.uuid('lot_id').nullable()
      table.string('status', 10).notNullable()
      table.uuid('warehouse_id').nullable()
      table.uuid('location_id').nullable()
      table.string('bucket', 12).nullable()
      table.uuid('last_posting_id').notNullable()
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'last_posting_id', 'stock_postings')
      table.unique(['tenant_id', 'product_id', 'serial'], { indexName: 'stock_serials_unique' })
      table.index(['tenant_id', 'serial'], 'stock_serials_serial_index')
      table.check(`status IN ('IN_STOCK','OUT')`, [], 'stock_serials_status_check')
      table.check(
        `(status = 'IN_STOCK') = (warehouse_id IS NOT NULL AND bucket IS NOT NULL)`,
        [],
        'stock_serials_place_check'
      )
      table.check(
        `bucket IS NULL OR bucket IN ('UNRESTRICTED','BLOCKED','QUARANTINE','IN_TRANSIT')`,
        [],
        'stock_serials_bucket_check'
      )
    })
    this.schema.raw(`ALTER TABLE stock_serials ADD CONSTRAINT stock_serials_lot_fk
      FOREIGN KEY (tenant_id, product_id, lot_id) REFERENCES stock_lots (tenant_id, product_id, id)
      ON DELETE RESTRICT`)
    createTenantTable(this, 'stock_serial_movements', (table) => {
      table.uuid('serial_id').notNullable()
      table.uuid('posting_id').notNullable()
      table.integer('line_no').notNullable()
      table.smallint('delta').notNullable()
      table.uuid('warehouse_id').notNullable()
      table.uuid('location_id').nullable()
      table.uuid('lot_id').nullable()
      table.string('bucket', 12).notNullable()
      tenantForeignKey(table, 'serial_id', 'stock_serials')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      table.index(['tenant_id', 'serial_id'], 'stock_serial_movements_serial_index')
      table.index(['tenant_id', 'posting_id'], 'stock_serial_movements_posting_index')
      table.check('delta IN (-1, 1)', [], 'stock_serial_movements_delta_check')
    })
    this.schema.raw(`
      CREATE FUNCTION stock_lot_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'STOCK_APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    for (const t of ['stock_lot_events', 'stock_serial_movements'])
      this.schema.raw(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION stock_lot_append_only()`)

    // Contagens: o saldo contado inclui o lote.
    this.schema.raw('ALTER TABLE stock_count_lines ADD COLUMN lot_id uuid NULL')
    this.schema.raw(`ALTER TABLE stock_count_lines ADD CONSTRAINT stock_count_lines_lot_fk
      FOREIGN KEY (tenant_id, product_id, lot_id) REFERENCES stock_lots (tenant_id, product_id, id)
      ON DELETE RESTRICT`)
    this.schema.raw('DROP INDEX stock_count_lines_key_unique')
    this.schema.raw(`CREATE UNIQUE INDEX stock_count_lines_key_unique ON stock_count_lines
      (tenant_id, count_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), product_id,
       coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
       coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid))`)
  }

  async down() {
    this.schema.raw('DROP INDEX stock_count_lines_key_unique')
    this.schema.raw(`CREATE UNIQUE INDEX stock_count_lines_key_unique ON stock_count_lines
      (tenant_id, count_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), product_id,
       coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))`)
    this.schema.raw('ALTER TABLE stock_count_lines DROP COLUMN lot_id')
    this.schema.dropTable('stock_serial_movements')
    this.schema.dropTable('stock_serials')
    this.schema.raw(`
      CREATE OR REPLACE FUNCTION stock_movements_apply() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        u numeric := CASE WHEN NEW.bucket = 'UNRESTRICTED' THEN NEW.quantity ELSE 0 END;
        b numeric := CASE WHEN NEW.bucket = 'BLOCKED' THEN NEW.quantity ELSE 0 END;
        q numeric := CASE WHEN NEW.bucket = 'QUARANTINE' THEN NEW.quantity ELSE 0 END;
        r numeric := CASE WHEN NEW.bucket = 'RESERVED' THEN NEW.quantity ELSE 0 END;
        t numeric := CASE WHEN NEW.bucket = 'IN_TRANSIT' THEN NEW.quantity ELSE 0 END;
        e numeric := CASE WHEN NEW.bucket = 'EXPECTED' THEN NEW.quantity ELSE 0 END;
      BEGIN
        LOOP
          UPDATE stock_balances SET
            qty_unrestricted = qty_unrestricted + u, qty_blocked = qty_blocked + b,
            qty_quarantine = qty_quarantine + q, qty_reserved = qty_reserved + r,
            qty_in_transit = qty_in_transit + t, qty_expected = qty_expected + e,
            last_movement_at = NEW.occurred_at, updated_at = now(), updated_by = NEW.created_by,
            version = version + 1
          WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id AND product_id = NEW.product_id
            AND location_id IS NOT DISTINCT FROM NEW.location_id AND variant_id IS NOT DISTINCT FROM NEW.variant_id;
          EXIT WHEN FOUND;
          BEGIN
            INSERT INTO stock_balances (tenant_id, warehouse_id, location_id, product_id, variant_id,
                qty_unrestricted, qty_blocked, qty_quarantine, qty_reserved, qty_in_transit, qty_expected,
                last_movement_at, created_by, updated_by)
              VALUES (NEW.tenant_id, NEW.warehouse_id, NEW.location_id, NEW.product_id, NEW.variant_id,
                u, b, q, r, t, e, NEW.occurred_at, NEW.created_by, NEW.created_by);
            EXIT;
          EXCEPTION WHEN unique_violation THEN
          END;
        END LOOP;
        RETURN NULL;
      END $$`)
    this.schema.raw('ALTER TABLE stock_balances DROP CONSTRAINT stock_balances_key_unique')
    this.schema.raw(`ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_key_unique
      UNIQUE NULLS NOT DISTINCT (tenant_id, warehouse_id, location_id, product_id, variant_id)`)
    for (const t of ['stock_movements', 'stock_balances'])
      this.schema.raw(`ALTER TABLE ${t} DROP COLUMN lot_id`)
    this.schema.dropTable('stock_lot_events')
    this.schema.dropTable('stock_lots')
    this.schema.raw('DROP FUNCTION stock_lot_append_only()')
    this.schema.raw('DROP FUNCTION stock_lots_fixed()')
  }
}
