import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recepções de compra (Prompt 09, bloco 9.7).
 *
 *  - `purchase_receipts`: recepção de uma ordem de compra emitida — data, guia do fornecedor, armazém (só quando há
 *    bens armazenáveis), estado (rascunho → confirmada; rascunho anulado; confirmada estornada). A confirmação dá o
 *    número da série `PURCHASE_RECEIPT` e, para os bens armazenáveis, um único pedido de entrada ao Inventário
 *    (`receivePurchase`, idempotente pela recepção) — guarda o evento de integração e o lançamento de stock. O estorno
 *    estorna esse lançamento e devolve as quantidades à ordem.
 *  - `purchase_receipt_lines`: por linha da ordem, a quantidade aceite (na unidade da ordem e na unidade base do
 *    produto), a recusada com motivo, lote/validade/séries, localização e o custo unitário na moeda funcional; serviços
 *    e artigos não armazenáveis são só aceites (sem stock).
 *  - `purchase_receipt_events`: histórico (só acréscimo).
 *  Confirmada, a recepção e as linhas não mudam (só o estorno); nunca se apagam.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'purchase_receipts', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('order_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.uuid('warehouse_id').nullable()
      table.date('receipt_date').notNullable()
      table.string('delivery_note', 60).nullable()
      table.text('notes').nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.uuid('confirmed_by').nullable()
      table.uuid('integration_event_id').nullable()
      table.uuid('posting_id').nullable()
      table.uuid('reversal_posting_id').nullable()
      table.timestamp('reversed_at', { useTz: true }).nullable()
      table.uuid('reversed_by').nullable()
      table.string('reversal_reason', 500).nullable()
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'series_id', 'document_series')
      tenantForeignKey(table, 'integration_event_id', 'inventory_integration_events')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      tenantForeignKey(table, 'reversal_posting_id', 'stock_postings')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'purchase_receipts_number_unique',
      })
      table.index(['tenant_id', 'order_id'], 'purchase_receipts_order_index')
      table.check(
        `status IN ('DRAFT','CONFIRMED','REVERSED','CANCELLED')`,
        [],
        'purchase_receipts_status_check'
      )
      table.check(
        `status IN ('DRAFT','CANCELLED') OR (number IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)`,
        [],
        'purchase_receipts_confirmed_check'
      )
      table.check(
        `(status = 'REVERSED') = (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL)`,
        [],
        'purchase_receipts_reversed_check'
      )
      table.check(
        `status <> 'CANCELLED' OR cancel_reason IS NOT NULL`,
        [],
        'purchase_receipts_cancel_check'
      )
      table.check(
        '(posting_id IS NULL) = (integration_event_id IS NULL)',
        [],
        'purchase_receipts_posting_check'
      )
    })

    createTenantTable(this, 'purchase_receipt_lines', (table) => {
      table.uuid('receipt_id').notNullable()
      table.uuid('order_line_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').nullable()
      table.uuid('variant_id').nullable()
      table.boolean('stocked').notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('base_quantity', 18, 6).nullable()
      table.decimal('rejected_quantity', 18, 6).notNullable().defaultTo(0)
      table.string('reject_reason', 500).nullable()
      table.uuid('location_id').nullable()
      table.string('lot_code', 60).nullable()
      table.date('expiry_date').nullable()
      table.jsonb('serials').nullable()
      table.decimal('unit_cost', 20, 6).nullable()
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'receipt_id', 'purchase_receipts')
      tenantForeignKey(table, 'order_line_id', 'purchase_order_lines')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'location_id', 'warehouse_locations')
      table.unique(['tenant_id', 'receipt_id', 'order_line_id'], {
        indexName: 'purchase_receipt_lines_line_unique',
      })
      table.check(
        'quantity >= 0 AND rejected_quantity >= 0 AND quantity + rejected_quantity > 0',
        [],
        'purchase_receipt_lines_quantity_check'
      )
      table.check(
        'rejected_quantity = 0 OR reject_reason IS NOT NULL',
        [],
        'purchase_receipt_lines_reject_check'
      )
      table.check(
        `(base_quantity IS NULL) = (unit_cost IS NULL)
         AND (base_quantity IS NULL OR (stocked AND base_quantity > 0 AND unit_cost >= 0))`,
        [],
        'purchase_receipt_lines_stock_check'
      )
    })

    createTenantTable(this, 'purchase_receipt_events', (table) => {
      table.uuid('receipt_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'receipt_id', 'purchase_receipts')
      table.index(['tenant_id', 'receipt_id'], 'purchase_receipt_events_receipt_index')
    })

    this.schema.raw(`
      CREATE FUNCTION purchase_receipt_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_receipt_events_fixed BEFORE UPDATE OR DELETE
      ON purchase_receipt_events FOR EACH ROW EXECUTE FUNCTION purchase_receipt_events_fixed()`)

    // Recepção: livre em rascunho; confirmada só passa a estornada (com o estorno); finais imutáveis; nunca se apaga.
    this.schema.raw(`
      CREATE FUNCTION purchase_receipts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status IN ('REVERSED','CANCELLED') THEN
          RAISE EXCEPTION 'PURCHASE_RECEIPT_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
           OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
          RAISE EXCEPTION 'PURCHASE_RECEIPT_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'CONFIRMED' AND (NEW.status <> 'REVERSED'
             OR NEW.number IS DISTINCT FROM OLD.number OR NEW.series_id IS DISTINCT FROM OLD.series_id
             OR NEW.receipt_date IS DISTINCT FROM OLD.receipt_date OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
             OR NEW.delivery_note IS DISTINCT FROM OLD.delivery_note
             OR NEW.posting_id IS DISTINCT FROM OLD.posting_id
             OR NEW.integration_event_id IS DISTINCT FROM OLD.integration_event_id
             OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
          RAISE EXCEPTION 'PURCHASE_RECEIPT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_receipts_fixed BEFORE UPDATE OR DELETE
      ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION purchase_receipts_fixed()`)

    // Linhas: só em rascunho.
    this.schema.raw(`
      CREATE FUNCTION purchase_receipt_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE st text;
      BEGIN
        SELECT status INTO st FROM purchase_receipts WHERE id = COALESCE(OLD.receipt_id, NEW.receipt_id);
        IF st IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'PURCHASE_RECEIPT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_receipt_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON purchase_receipt_lines FOR EACH ROW EXECUTE FUNCTION purchase_receipt_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('purchase_receipt_events')
    this.schema.dropTable('purchase_receipt_lines')
    this.schema.dropTable('purchase_receipts')
    for (const f of [
      'purchase_receipts_fixed',
      'purchase_receipt_lines_fixed',
      'purchase_receipt_events_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
