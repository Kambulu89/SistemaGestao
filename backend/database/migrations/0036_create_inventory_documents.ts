import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Entradas e saídas de stock (Prompt 08, bloco 8.4).
 *
 *  - `stock_documents`: cabeçalho (tipo, armazém, entidade legal do armazém, série e número — reservado na primeira
 *    confirmação —, data, origem, referência, contraparte, moeda, estado e marcas de conferência/fecho/anulação).
 *  - `stock_document_lines`: produto/variante, unidade do documento com o factor de conversão congelado, quantidade e
 *    quantidade base, localização, estado do stock, lote, séries, validade, custo unitário; quantidade conferida
 *    (ronda actual) e confirmada (acumulada).
 *  - `stock_document_confirmations` (+ linhas): cada confirmação gera um lançamento de stock (`stock_postings`) e pode
 *    ser estornada (outro lançamento). Só acréscimo, excepto as marcas do estorno, preenchidas uma vez.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'stock_documents', (table) => {
      table.string('doc_type', 8).notNullable()
      table.uuid('warehouse_id').notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.date('document_date').notNullable()
      table.string('origin', 12).notNullable()
      table.string('origin_ref', 60).nullable()
      table.string('counterparty', 160).nullable()
      table.string('notes', 500).nullable()
      table.string('currency', 3).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.uuid('checked_by').nullable()
      table.timestamp('checked_at', { useTz: true }).nullable()
      table.timestamp('completed_at', { useTz: true }).nullable()
      table.boolean('closed_short').notNullable().defaultTo(false)
      table.string('close_reason', 300).nullable()
      table.string('cancel_reason', 300).nullable()
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'stock_documents_number_unique',
      })
      table.index(['tenant_id', 'warehouse_id', 'status'], 'stock_documents_warehouse_index')
      table.check(`doc_type IN ('RECEIPT','ISSUE')`, [], 'stock_documents_type_check')
      table.check(
        `status IN ('DRAFT','CHECKED','PARTIAL','COMPLETED','CANCELLED')`,
        [],
        'stock_documents_status_check'
      )
      table.check(
        `origin IN ('PURCHASE','RETURN','PRODUCTION','OPENING','CONSUMPTION','SALE','LOSS','SAMPLE','OTHER')`,
        [],
        'stock_documents_origin_check'
      )
      table.check('(number IS NULL) = (series_id IS NULL)', [], 'stock_documents_number_check')
      table.check(
        `(status = 'CANCELLED') = (cancel_reason IS NOT NULL)`,
        [],
        'stock_documents_cancel_check'
      )
      table.check('NOT closed_short OR close_reason IS NOT NULL', [], 'stock_documents_close_check')
    })

    createTenantTable(this, 'stock_document_lines', (table) => {
      table.uuid('document_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.uuid('uom_id').notNullable()
      table.decimal('factor', 18, 6).notNullable()
      table.decimal('quantity', 20, 6).notNullable()
      table.decimal('base_quantity', 20, 6).notNullable()
      table.uuid('warehouse_id').notNullable()
      table.uuid('location_id').nullable()
      table.string('bucket', 12).notNullable().defaultTo('UNRESTRICTED')
      table.string('lot_code', 40).nullable()
      table.jsonb('serials').nullable()
      table.date('expiry_date').nullable()
      table.decimal('unit_cost', 20, 6).nullable()
      table.decimal('checked_quantity', 20, 6).nullable()
      table.string('difference_reason', 200).nullable()
      table.decimal('confirmed_quantity', 20, 6).notNullable().defaultTo(0)
      tenantForeignKey(table, 'document_id', 'stock_documents', 'CASCADE')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'uom_id', 'uoms')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      table.unique(['tenant_id', 'document_id', 'line_no'], {
        indexName: 'stock_document_lines_no_unique',
      })
      table.index(['tenant_id', 'product_id'], 'stock_document_lines_product_index')
      table.check(
        `bucket IN ('UNRESTRICTED','BLOCKED','QUARANTINE')`,
        [],
        'stock_document_lines_bucket_check'
      )
      table.check(
        'quantity > 0 AND base_quantity > 0 AND factor > 0',
        [],
        'stock_document_lines_qty_check'
      )
      table.check(
        'confirmed_quantity >= 0 AND confirmed_quantity <= quantity',
        [],
        'stock_document_lines_confirmed_check'
      )
      table.check(
        'checked_quantity IS NULL OR (checked_quantity >= 0 AND checked_quantity + confirmed_quantity <= quantity)',
        [],
        'stock_document_lines_checked_check'
      )
      table.check('unit_cost IS NULL OR unit_cost >= 0', [], 'stock_document_lines_cost_check')
    })
    this.schema
      .raw(`ALTER TABLE stock_document_lines ADD CONSTRAINT stock_document_lines_location_fk
      FOREIGN KEY (tenant_id, warehouse_id, location_id)
      REFERENCES warehouse_locations (tenant_id, warehouse_id, id) ON DELETE RESTRICT`)
    this.schema.raw(`ALTER TABLE stock_document_lines ADD CONSTRAINT stock_document_lines_variant_fk
      FOREIGN KEY (tenant_id, product_id, variant_id)
      REFERENCES product_variants (tenant_id, product_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'stock_document_confirmations', (table) => {
      table.uuid('document_id').notNullable()
      table.integer('seq').notNullable()
      table.string('idempotency_key', 100).notNullable()
      table.uuid('posting_id').notNullable()
      table.uuid('reversal_posting_id').nullable()
      table.timestamp('reversed_at', { useTz: true }).nullable()
      table.uuid('reversed_by').nullable()
      table.string('reverse_reason', 300).nullable()
      tenantForeignKey(table, 'document_id', 'stock_documents')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      tenantForeignKey(table, 'reversal_posting_id', 'stock_postings')
      table.unique(['tenant_id', 'document_id', 'seq'], {
        indexName: 'stock_document_confirmations_seq_unique',
      })
      table.unique(['tenant_id', 'document_id', 'idempotency_key'], {
        indexName: 'stock_document_confirmations_key_unique',
      })
      table.check(
        '(reversal_posting_id IS NULL) = (reversed_at IS NULL) AND (reversed_at IS NULL) = (reverse_reason IS NULL)',
        [],
        'stock_document_confirmations_reversal_check'
      )
    })

    createTenantTable(this, 'stock_document_confirmation_lines', (table) => {
      table.uuid('confirmation_id').notNullable()
      table.uuid('line_id').notNullable()
      table.decimal('quantity', 20, 6).notNullable()
      table.decimal('base_quantity', 20, 6).notNullable()
      tenantForeignKey(table, 'confirmation_id', 'stock_document_confirmations')
      tenantForeignKey(table, 'line_id', 'stock_document_lines')
      table.unique(['tenant_id', 'confirmation_id', 'line_id'], {
        indexName: 'stock_document_confirmation_lines_unique',
      })
      table.check(
        'quantity > 0 AND base_quantity > 0',
        [],
        'stock_document_confirmation_lines_qty_check'
      )
    })

    // Confirmações: só acréscimo; o estorno preenche uma vez as suas marcas e nada mais muda.
    this.schema.raw(`
      CREATE FUNCTION stock_document_confirmations_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.reversal_posting_id IS NOT NULL
           OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.seq IS DISTINCT FROM OLD.seq
           OR NEW.posting_id IS DISTINCT FROM OLD.posting_id
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
          RAISE EXCEPTION 'CONFIRMATION_FIXED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER stock_document_confirmations_fixed BEFORE UPDATE OR DELETE
      ON stock_document_confirmations FOR EACH ROW EXECUTE FUNCTION stock_document_confirmations_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION stock_append_only_lines() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'CONFIRMATION_FIXED' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER stock_document_confirmation_lines_fixed BEFORE UPDATE OR DELETE
      ON stock_document_confirmation_lines FOR EACH ROW EXECUTE FUNCTION stock_append_only_lines()`)
    // Linhas de documentos com confirmações não se apagam nem mudam de produto, unidade, factor ou localização.
    this.schema.raw(`
      CREATE FUNCTION stock_document_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM stock_document_confirmation_lines c
                    WHERE c.tenant_id = OLD.tenant_id AND c.line_id = OLD.id) THEN
          IF TG_OP = 'DELETE' OR NEW.product_id IS DISTINCT FROM OLD.product_id
             OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.uom_id IS DISTINCT FROM OLD.uom_id
             OR NEW.factor IS DISTINCT FROM OLD.factor OR NEW.quantity IS DISTINCT FROM OLD.quantity
             OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.bucket IS DISTINCT FROM OLD.bucket
             OR NEW.lot_code IS DISTINCT FROM OLD.lot_code OR NEW.serials IS DISTINCT FROM OLD.serials
             OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
            RAISE EXCEPTION 'LINE_CONFIRMED' USING ERRCODE = '23000';
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER stock_document_lines_fixed BEFORE UPDATE OR DELETE ON stock_document_lines
      FOR EACH ROW EXECUTE FUNCTION stock_document_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('stock_document_confirmation_lines')
    this.schema.dropTable('stock_document_confirmations')
    this.schema.dropTable('stock_document_lines')
    this.schema.dropTable('stock_documents')
    this.schema.raw('DROP FUNCTION stock_document_lines_fixed()')
    this.schema.raw('DROP FUNCTION stock_append_only_lines()')
    this.schema.raw('DROP FUNCTION stock_document_confirmations_fixed()')
  }
}
