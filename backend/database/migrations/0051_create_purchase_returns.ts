import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Devoluções a fornecedor, não conformidades e notas de crédito (Prompt 09, bloco 9.9).
 *
 *  - `purchase_returns`: não conformidade de uma recepção confirmada — data, motivo (código e descrição), solução
 *    pedida (substituição ou crédito), estado (rascunho → confirmada; rascunho anulado) e estado do crédito (não é
 *    preciso, pendente, creditada). A confirmação exige evidência (anexo), dá o número da série `PURCHASE_RETURN`,
 *    faz **uma** saída no Inventário para os bens armazenáveis aceites (`returnToSupplier`, idempotente pela devolução)
 *    e tira a quantidade ao recebido da ordem (a crédito, também ao que falta receber).
 *  - `purchase_return_lines`: por linha da recepção, de onde vem (aceite, que estava em stock, ou recusada na
 *    conferência), quantidade (na unidade da ordem e na base), lote, séries, localização e estado de stock de onde sai,
 *    e quanto fica por creditar (o que já estava facturado) e já creditado.
 *  - `purchase_credit_notes` / `purchase_credit_note_lines`: nota de crédito do fornecedor sobre uma factura
 *    validada — número externo (único por fornecedor, fora as anuladas), data, moeda e câmbio da factura, linhas por
 *    linha da factura (quantidade devolvida ao preço da factura, ou ajuste de valor), opcionalmente ligadas a uma linha
 *    de devolução. Validada, abate a quantidade facturada da ordem e o crédito pendente da devolução.
 *  - `purchase_return_events` / `purchase_credit_note_events`: histórico (só acréscimo).
 *  Confirmadas/validadas não mudam (só o estado do crédito da devolução, pela nota de crédito); nunca se apagam.
 *  O Inventário passa a aceitar o evento de integração `PURCHASE_RETURN`.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(
      `ALTER TABLE inventory_integration_events DROP CONSTRAINT inventory_integration_events_kind_check`
    )
    this.schema
      .raw(`ALTER TABLE inventory_integration_events ADD CONSTRAINT inventory_integration_events_kind_check
      CHECK (kind IN ('PURCHASE_RECEIPT','PURCHASE_RETURN','SALE_RESERVATION','SALE_RELEASE','SALE_DELIVERY','SALE_RETURN'))`)

    createTenantTable(this, 'purchase_returns', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('receipt_id').notNullable()
      table.uuid('order_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.uuid('warehouse_id').nullable()
      table.date('return_date').notNullable()
      table.string('reason_code', 20).notNullable()
      table.string('description', 2000).notNullable()
      table.string('remedy', 12).notNullable()
      table.string('carrier_ref', 60).nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.string('credit_status', 12).notNullable().defaultTo('NOT_REQUIRED')
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.uuid('confirmed_by').nullable()
      table.uuid('integration_event_id').nullable()
      table.uuid('posting_id').nullable()
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'receipt_id', 'purchase_receipts')
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'series_id', 'document_series')
      tenantForeignKey(table, 'integration_event_id', 'inventory_integration_events')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'purchase_returns_number_unique',
      })
      table.index(['tenant_id', 'receipt_id'], 'purchase_returns_receipt_index')
      table.index(['tenant_id', 'order_id'], 'purchase_returns_order_index')
      table.check(
        `status IN ('DRAFT','CONFIRMED','CANCELLED')`,
        [],
        'purchase_returns_status_check'
      )
      table.check(
        `credit_status IN ('NOT_REQUIRED','PENDING','CREDITED')`,
        [],
        'purchase_returns_credit_status_check'
      )
      table.check(
        `reason_code IN ('QUALITY','DAMAGED','WRONG_ITEM','EXPIRED','QUANTITY','DOCUMENTATION','OTHER')`,
        [],
        'purchase_returns_reason_check'
      )
      table.check(`remedy IN ('REPLACEMENT','CREDIT')`, [], 'purchase_returns_remedy_check')
      table.check(
        `status <> 'CONFIRMED' OR (number IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)`,
        [],
        'purchase_returns_confirmed_check'
      )
      table.check(
        `status <> 'CANCELLED' OR cancel_reason IS NOT NULL`,
        [],
        'purchase_returns_cancel_check'
      )
      table.check(
        `status = 'CONFIRMED' OR credit_status = 'NOT_REQUIRED'`,
        [],
        'purchase_returns_credit_check'
      )
      table.check(
        '(posting_id IS NULL) = (integration_event_id IS NULL)',
        [],
        'purchase_returns_posting_check'
      )
    })

    createTenantTable(this, 'purchase_return_lines', (table) => {
      table.uuid('return_id').notNullable()
      table.uuid('receipt_line_id').notNullable()
      table.uuid('order_line_id').notNullable()
      table.integer('line_no').notNullable()
      table.string('source', 10).notNullable()
      table.uuid('product_id').nullable()
      table.uuid('variant_id').nullable()
      table.boolean('stocked').notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('base_quantity', 18, 6).nullable()
      table.uuid('location_id').nullable()
      table.string('bucket', 12).nullable()
      table.string('lot_code', 60).nullable()
      table.jsonb('serials').nullable()
      table.decimal('credit_quantity', 18, 6).notNullable().defaultTo(0)
      table.decimal('credited_quantity', 18, 6).notNullable().defaultTo(0)
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'return_id', 'purchase_returns')
      tenantForeignKey(table, 'receipt_line_id', 'purchase_receipt_lines')
      tenantForeignKey(table, 'order_line_id', 'purchase_order_lines')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'location_id', 'warehouse_locations')
      table.unique(['tenant_id', 'return_id', 'receipt_line_id', 'source'], {
        indexName: 'purchase_return_lines_line_unique',
      })
      table.check(`source IN ('ACCEPTED','REFUSED')`, [], 'purchase_return_lines_source_check')
      table.check(
        `quantity > 0 AND credit_quantity >= 0 AND credited_quantity >= 0 AND credited_quantity <= credit_quantity
         AND credit_quantity <= quantity`,
        [],
        'purchase_return_lines_quantity_check'
      )
      // Só sai do stock o que foi aceite e é armazenável; a recusada nunca entrou.
      table.check(
        `(stocked AND source = 'ACCEPTED') OR (base_quantity IS NULL AND bucket IS NULL AND lot_code IS NULL
           AND serials IS NULL AND location_id IS NULL)`,
        [],
        'purchase_return_lines_stock_check'
      )
      table.check(
        `bucket IS NULL OR bucket IN ('UNRESTRICTED','BLOCKED','QUARANTINE')`,
        [],
        'purchase_return_lines_bucket_check'
      )
    })

    createTenantTable(this, 'purchase_credit_notes', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.uuid('order_id').notNullable()
      table.uuid('invoice_id').notNullable()
      table.uuid('return_id').nullable()
      table.string('credit_note_number', 60).notNullable()
      table.string('credit_note_number_key', 60).notNullable()
      table.date('credit_note_date').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.string('reason', 500).notNullable()
      table.decimal('declared_total', 20, 2).notNullable()
      table.decimal('total_net', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_tax', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('exchange_rate', 20, 10).notNullable()
      table.decimal('total_functional', 20, 2).nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.timestamp('validated_at', { useTz: true }).nullable()
      table.uuid('validated_by').nullable()
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      tenantForeignKey(table, 'invoice_id', 'purchase_invoices')
      tenantForeignKey(table, 'return_id', 'purchase_returns')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'purchase_credit_notes_number_unique',
      })
      table.index(['tenant_id', 'invoice_id'], 'purchase_credit_notes_invoice_index')
      table.index(['tenant_id', 'return_id'], 'purchase_credit_notes_return_index')
      table.check(
        `status IN ('DRAFT','VALIDATED','CANCELLED')`,
        [],
        'purchase_credit_notes_status_check'
      )
      table.check(
        `status <> 'VALIDATED' OR (number IS NOT NULL AND validated_at IS NOT NULL AND total_functional IS NOT NULL)`,
        [],
        'purchase_credit_notes_validated_check'
      )
      table.check(
        `status <> 'CANCELLED' OR cancel_reason IS NOT NULL`,
        [],
        'purchase_credit_notes_cancel_check'
      )
      table.check(
        `declared_total > 0 AND total_amount = total_net + total_tax AND total_net >= 0 AND total_tax >= 0`,
        [],
        'purchase_credit_notes_values_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX purchase_credit_notes_external_unique ON purchase_credit_notes
      (tenant_id, supplier_id, credit_note_number_key) WHERE status <> 'CANCELLED'`)

    createTenantTable(this, 'purchase_credit_note_lines', (table) => {
      table.uuid('credit_note_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('invoice_line_id').notNullable()
      table.uuid('order_line_id').nullable()
      table.uuid('return_line_id').nullable()
      table.string('kind', 10).notNullable()
      table.decimal('quantity', 18, 6).notNullable().defaultTo(0)
      table.decimal('net_amount', 20, 2).notNullable()
      table.decimal('tax_rate', 6, 3).notNullable()
      table.decimal('tax_amount', 20, 2).notNullable()
      table.decimal('total_amount', 20, 2).notNullable()
      tenantForeignKey(table, 'credit_note_id', 'purchase_credit_notes')
      tenantForeignKey(table, 'invoice_line_id', 'purchase_invoice_lines')
      tenantForeignKey(table, 'order_line_id', 'purchase_order_lines')
      tenantForeignKey(table, 'return_line_id', 'purchase_return_lines')
      table.unique(['tenant_id', 'credit_note_id', 'line_no'], {
        indexName: 'purchase_credit_note_lines_no_unique',
      })
      table.check(`kind IN ('QUANTITY','PRICE')`, [], 'purchase_credit_note_lines_kind_check')
      table.check(
        `net_amount > 0 AND tax_amount >= 0 AND total_amount = net_amount + tax_amount
         AND ((kind = 'QUANTITY' AND quantity > 0 AND order_line_id IS NOT NULL)
              OR (kind = 'PRICE' AND quantity = 0 AND return_line_id IS NULL))`,
        [],
        'purchase_credit_note_lines_values_check'
      )
    })

    for (const [t, fk] of [
      ['purchase_return_events', 'return_id'],
      ['purchase_credit_note_events', 'credit_note_id'],
    ] as const) {
      createTenantTable(this, t, (table) => {
        table.uuid(fk).notNullable()
        table.string('kind', 30).notNullable()
        table.string('reason', 500).nullable()
        table.jsonb('details').nullable()
        tenantForeignKey(
          table,
          fk,
          fk === 'return_id' ? 'purchase_returns' : 'purchase_credit_notes'
        )
        table.index(['tenant_id', fk], `${t}_parent_index`)
      })
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Devolução: livre em rascunho; confirmada só muda o estado do crédito; anulada imutável; nunca se apaga.
    this.schema.raw(`
      CREATE FUNCTION purchase_returns_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status = 'CANCELLED' THEN
          RAISE EXCEPTION 'PURCHASE_RETURN_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.receipt_id IS DISTINCT FROM OLD.receipt_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
           OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
          RAISE EXCEPTION 'PURCHASE_RETURN_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'CONFIRMED' AND (NEW.status <> 'CONFIRMED'
             OR NEW.number IS DISTINCT FROM OLD.number OR NEW.series_id IS DISTINCT FROM OLD.series_id
             OR NEW.return_date IS DISTINCT FROM OLD.return_date OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
             OR NEW.description IS DISTINCT FROM OLD.description OR NEW.remedy IS DISTINCT FROM OLD.remedy
             OR NEW.carrier_ref IS DISTINCT FROM OLD.carrier_ref OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
             OR NEW.posting_id IS DISTINCT FROM OLD.posting_id
             OR NEW.integration_event_id IS DISTINCT FROM OLD.integration_event_id
             OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
          RAISE EXCEPTION 'PURCHASE_RETURN_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_returns_fixed BEFORE UPDATE OR DELETE
      ON purchase_returns FOR EACH ROW EXECUTE FUNCTION purchase_returns_fixed()`)

    // Linhas da devolução: livres em rascunho; confirmada só muda o creditado (e só para cima); nunca se apagam depois.
    this.schema.raw(`
      CREATE FUNCTION purchase_return_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE st text;
      BEGIN
        SELECT status INTO st FROM purchase_returns WHERE id = COALESCE(OLD.return_id, NEW.return_id);
        IF st = 'DRAFT' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF TG_OP = 'UPDATE' AND st = 'CONFIRMED' AND NEW.credited_quantity >= OLD.credited_quantity
           AND NEW.credit_quantity = OLD.credit_quantity
           AND NEW.quantity = OLD.quantity AND NEW.receipt_line_id = OLD.receipt_line_id AND NEW.source = OLD.source
           AND NEW.base_quantity IS NOT DISTINCT FROM OLD.base_quantity
           AND NEW.lot_code IS NOT DISTINCT FROM OLD.lot_code AND NEW.serials IS NOT DISTINCT FROM OLD.serials
           AND NEW.location_id IS NOT DISTINCT FROM OLD.location_id AND NEW.bucket IS NOT DISTINCT FROM OLD.bucket THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'PURCHASE_RETURN_FIXED' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_return_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON purchase_return_lines FOR EACH ROW EXECUTE FUNCTION purchase_return_lines_fixed()`)

    // Nota de crédito: livre em rascunho; validada e anulada imutáveis; nunca se apaga.
    this.schema.raw(`
      CREATE FUNCTION purchase_credit_notes_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status IN ('VALIDATED','CANCELLED') THEN
          RAISE EXCEPTION 'PURCHASE_CREDIT_NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
           OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate THEN
          RAISE EXCEPTION 'PURCHASE_CREDIT_NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_credit_notes_fixed BEFORE UPDATE OR DELETE
      ON purchase_credit_notes FOR EACH ROW EXECUTE FUNCTION purchase_credit_notes_fixed()`)

    this.schema.raw(`
      CREATE FUNCTION purchase_credit_note_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE st text;
      BEGIN
        SELECT status INTO st FROM purchase_credit_notes WHERE id = COALESCE(OLD.credit_note_id, NEW.credit_note_id);
        IF st IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'PURCHASE_CREDIT_NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER purchase_credit_note_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON purchase_credit_note_lines FOR EACH ROW EXECUTE FUNCTION purchase_credit_note_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('purchase_credit_note_events')
    this.schema.dropTable('purchase_credit_note_lines')
    this.schema.dropTable('purchase_credit_notes')
    this.schema.dropTable('purchase_return_events')
    this.schema.dropTable('purchase_return_lines')
    this.schema.dropTable('purchase_returns')
    for (const f of [
      'purchase_returns_fixed',
      'purchase_return_lines_fixed',
      'purchase_credit_notes_fixed',
      'purchase_credit_note_lines_fixed',
      'purchase_return_events_fixed',
      'purchase_credit_note_events_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
    this.schema.raw(
      `ALTER TABLE inventory_integration_events DROP CONSTRAINT inventory_integration_events_kind_check`
    )
    this.schema
      .raw(`ALTER TABLE inventory_integration_events ADD CONSTRAINT inventory_integration_events_kind_check
      CHECK (kind IN ('PURCHASE_RECEIPT','SALE_RESERVATION','SALE_RELEASE','SALE_DELIVERY','SALE_RETURN')) NOT VALID`)
    // NOT VALID: devoluções já registadas (só acréscimo) ficam; novas deixam de ser aceites.
  }
}
