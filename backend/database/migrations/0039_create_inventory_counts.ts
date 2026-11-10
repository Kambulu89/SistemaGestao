import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Contagens físicas e ajustes (Prompt 08, bloco 8.7).
 *
 *  - `stock_counts`: plano (armazém, zona opcional, categoria opcional, contagem cega), série e número no início,
 *    estado e marcas de cada passo; o ajuste é lançado na aprovação.
 *  - `stock_count_lines`: um saldo (localização/produto/variante) com o físico do sistema no snapshot, o contado da
 *    volta corrente, a recontagem pedida e o motivo/justificação da diferença.
 *  - `stock_count_entries`: cada quantidade registada (quem, quando, em que volta). Só acréscimo.
 *  - `stock_count_postings`: os lançamentos de ajuste da contagem. Só acréscimo.
 *
 * Aprovada ou anulada, a contagem e as suas linhas ficam fixas; depois do início, as linhas não se apagam.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'stock_counts', (table) => {
      table.uuid('warehouse_id').notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.string('description', 200).notNullable()
      table.boolean('blind').notNullable().defaultTo(true)
      table.uuid('location_id').nullable()
      table.uuid('category_id').nullable()
      table.date('planned_date').nullable()
      table.string('notes', 500).nullable()
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.uuid('started_by').nullable()
      table.timestamp('started_at', { useTz: true }).nullable()
      table.uuid('submitted_by').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.string('cancel_reason', 300).nullable()
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'category_id', 'product_categories')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'stock_counts_number_unique',
      })
      table.index(['tenant_id', 'warehouse_id', 'status'], 'stock_counts_warehouse_index')
      table.check(
        `status IN ('DRAFT','COUNTING','REVIEW','APPROVED','CANCELLED')`,
        [],
        'stock_counts_status_check'
      )
      table.check('(number IS NULL) = (series_id IS NULL)', [], 'stock_counts_number_check')
      table.check(
        `(status = 'DRAFT' OR (status = 'CANCELLED' AND number IS NULL)) = (number IS NULL)`,
        [],
        'stock_counts_started_check'
      )
      table.check(
        `(status = 'CANCELLED') = (cancel_reason IS NOT NULL)`,
        [],
        'stock_counts_cancel_check'
      )
      table.check(
        `(status = 'APPROVED') = (approved_at IS NOT NULL)`,
        [],
        'stock_counts_approved_check'
      )
    })
    this.schema.raw(`ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_location_fk
      FOREIGN KEY (tenant_id, warehouse_id, location_id)
      REFERENCES warehouse_locations (tenant_id, warehouse_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'stock_count_lines', (table) => {
      table.uuid('count_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('warehouse_id').notNullable()
      table.uuid('location_id').nullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.decimal('snapshot_quantity', 20, 6).notNullable()
      table.timestamp('snapshot_at', { useTz: true }).notNullable()
      table.decimal('counted_quantity', 20, 6).nullable()
      table.integer('round').notNullable().defaultTo(1)
      table.boolean('recount_requested').notNullable().defaultTo(false)
      table.string('recount_reason', 300).nullable()
      table.boolean('added_during_count').notNullable().defaultTo(false)
      table.string('reason_code', 20).nullable()
      table.string('justification', 300).nullable()
      tenantForeignKey(table, 'count_id', 'stock_counts', 'CASCADE')
      tenantForeignKey(table, 'product_id', 'products')
      table.unique(['tenant_id', 'count_id', 'line_no'], {
        indexName: 'stock_count_lines_no_unique',
      })
      table.index(['tenant_id', 'product_id'], 'stock_count_lines_product_index')
      table.check('snapshot_quantity >= 0', [], 'stock_count_lines_snapshot_check')
      table.check(
        'counted_quantity IS NULL OR counted_quantity >= 0',
        [],
        'stock_count_lines_counted_check'
      )
      table.check('round >= 1', [], 'stock_count_lines_round_check')
      table.check(
        `reason_code IS NULL OR reason_code IN ('COUNT_ERROR','UNRECORDED_RECEIPT','UNRECORDED_ISSUE','DAMAGE','EXPIRY','THEFT_LOSS','LOCATION_MIX','OTHER')`,
        [],
        'stock_count_lines_reason_check'
      )
      table.check(
        '(reason_code IS NULL) = (justification IS NULL)',
        [],
        'stock_count_lines_justification_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX stock_count_lines_key_unique ON stock_count_lines
      (tenant_id, count_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), product_id,
       coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))`)
    this.schema.raw(`ALTER TABLE stock_count_lines ADD CONSTRAINT stock_count_lines_location_fk
      FOREIGN KEY (tenant_id, warehouse_id, location_id)
      REFERENCES warehouse_locations (tenant_id, warehouse_id, id) ON DELETE RESTRICT`)
    this.schema.raw(`ALTER TABLE stock_count_lines ADD CONSTRAINT stock_count_lines_variant_fk
      FOREIGN KEY (tenant_id, product_id, variant_id) REFERENCES product_variants (tenant_id, product_id, id)
      ON DELETE RESTRICT`)

    createTenantTable(this, 'stock_count_entries', (table) => {
      table.uuid('count_id').notNullable()
      table.uuid('line_id').notNullable()
      table.integer('round').notNullable()
      table.decimal('quantity', 20, 6).notNullable()
      tenantForeignKey(table, 'count_id', 'stock_counts')
      tenantForeignKey(table, 'line_id', 'stock_count_lines')
      table.index(['tenant_id', 'count_id', 'created_by'], 'stock_count_entries_counter_index')
      table.check('quantity >= 0', [], 'stock_count_entries_qty_check')
    })
    createTenantTable(this, 'stock_count_postings', (table) => {
      table.uuid('count_id').notNullable()
      table.integer('seq').notNullable()
      table.uuid('posting_id').notNullable()
      tenantForeignKey(table, 'count_id', 'stock_counts')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      table.unique(['tenant_id', 'count_id', 'seq'], { indexName: 'stock_count_postings_unique' })
    })

    this.schema.raw(`
      CREATE FUNCTION stock_count_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'COUNT_RECORD_FIXED' USING ERRCODE = '23000';
      END $$`)
    for (const t of ['stock_count_entries', 'stock_count_postings'])
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION stock_count_append_only()`)

    // Contagem aprovada ou anulada não muda (o ajuste já foi lançado ou não há nada a lançar).
    this.schema.raw(`
      CREATE FUNCTION stock_counts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('APPROVED', 'CANCELLED') THEN
          RAISE EXCEPTION 'COUNT_CLOSED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
           OR (OLD.number IS NOT NULL AND (NEW.number IS DISTINCT FROM OLD.number
               OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.category_id IS DISTINCT FROM OLD.category_id
               OR NEW.blind IS DISTINCT FROM OLD.blind)) THEN
          RAISE EXCEPTION 'COUNT_PLAN_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER stock_counts_fixed BEFORE UPDATE OR DELETE ON stock_counts
      FOR EACH ROW EXECUTE FUNCTION stock_counts_fixed()`)
    // Linhas: fixas numa contagem fechada; depois do início não se apagam nem mudam de saldo.
    this.schema.raw(`
      CREATE FUNCTION stock_count_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE st text; num text;
      BEGIN
        SELECT c.status, c.number INTO st, num FROM stock_counts c
         WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.count_id;
        IF st IN ('APPROVED', 'CANCELLED') THEN
          RAISE EXCEPTION 'COUNT_CLOSED' USING ERRCODE = '23000';
        END IF;
        IF num IS NOT NULL AND (TG_OP = 'DELETE' OR NEW.product_id IS DISTINCT FROM OLD.product_id
             OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
          RAISE EXCEPTION 'COUNT_LINE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER stock_count_lines_fixed BEFORE UPDATE OR DELETE ON stock_count_lines
      FOR EACH ROW EXECUTE FUNCTION stock_count_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('stock_count_postings')
    this.schema.dropTable('stock_count_entries')
    this.schema.dropTable('stock_count_lines')
    this.schema.dropTable('stock_counts')
    this.schema.raw('DROP FUNCTION stock_count_lines_fixed()')
    this.schema.raw('DROP FUNCTION stock_counts_fixed()')
    this.schema.raw('DROP FUNCTION stock_count_append_only()')
  }
}
