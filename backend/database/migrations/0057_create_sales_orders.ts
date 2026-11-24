import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Encomendas de venda (Prompt 10, bloco 10.4) — módulo `sales`.
 *
 *  - `sales_orders`: cabeçalho com estados **separados**: ciclo (`status`: rascunho, confirmada, fechada, anulada),
 *    aprovação (`approval_status`), reserva (`reservation_status`), entrega (`delivery_status`) e facturação
 *    (`invoicing_status`, actualizada pela facturação no 10.6). Número pela série `SALES_ORDER` na confirmação; o
 *    orçamento de origem é único (`quote_id`). Guarda a verificação do limite de crédito e os motivos de aprovação.
 *  - `sales_order_lines`: quantidades encomendada, reservada (em aberto), entregue, facturada e fechada sem entrega;
 *    linhas de serviço não passam pelo inventário. Preço e imposto como no orçamento.
 *  - `sales_order_deliveries` + linhas: expedições (uma por pedido, idempotentes por chave), com o lançamento do
 *    Inventário; só de acréscimo.
 *  - `sales_order_events`: cronologia (só de acréscimo).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'sales_orders', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.uuid('customer_version_id').nullable()
      table.uuid('salesperson_membership_id').notNullable()
      table.uuid('warehouse_id').nullable()
      table.uuid('delivery_address_id').nullable()
      table.uuid('quote_id').nullable()
      table.uuid('series_id').nullable()
      table.string('number', 60).nullable()
      table.date('order_date').notNullable()
      table.date('requested_date').nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.integer('payment_terms_days').notNullable().defaultTo(0)
      table.string('customer_reference', 60).nullable()
      table.string('notes', 2000).nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.string('approval_status', 12).notNullable().defaultTo('NOT_REQUIRED')
      table.string('reservation_status', 14).notNullable().defaultTo('NONE')
      table.string('delivery_status', 10).notNullable().defaultTo('NONE')
      table.string('invoicing_status', 10).notNullable().defaultTo('NONE')
      table.specificType('approval_reasons', 'text[]').notNullable().defaultTo('{}')
      table.jsonb('credit_check').nullable()
      table.decimal('net_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('tax_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('gross_total', 20, 2).notNullable().defaultTo(0)
      table.string('pricing_hash', 64).nullable()
      table.uuid('submitted_by').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.string('closed_reason', 500).nullable()
      table.integer('reservation_seq').notNullable().defaultTo(0)
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'customer_version_id', 'customer_versions')
      tenantForeignKey(table, 'salesperson_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'delivery_address_id', 'customer_addresses')
      tenantForeignKey(table, 'quote_id', 'sales_quotes')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.index(['tenant_id', 'legal_entity_id', 'status'], 'sales_orders_entity_index')
      table.index(['tenant_id', 'customer_id', 'status'], 'sales_orders_customer_index')
      table.check(
        `status IN ('DRAFT','CONFIRMED','CLOSED','CANCELLED')`,
        [],
        'sales_orders_status_check'
      )
      table.check(
        `approval_status IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')
         AND reservation_status IN ('NONE','PARTIAL','FULL','NOT_APPLICABLE')
         AND delivery_status IN ('NONE','PARTIAL','FULL')
         AND invoicing_status IN ('NONE','PARTIAL','FULL')`,
        [],
        'sales_orders_substatus_check'
      )
      table.check(
        `payment_terms_days BETWEEN 0 AND 365 AND (requested_date IS NULL OR requested_date >= order_date)
         AND net_total >= 0 AND tax_total >= 0 AND gross_total = net_total + tax_total
         AND (number IS NULL OR series_id IS NOT NULL)
         AND (status = 'DRAFT' OR status = 'CANCELLED' OR number IS NOT NULL)
         AND (status IN ('DRAFT','CANCELLED') OR approval_status IN ('NOT_REQUIRED','APPROVED'))
         AND (approved_by IS NULL OR approved_by <> submitted_by)
         AND (status <> 'CLOSED' OR closed_reason IS NOT NULL OR delivery_status = 'FULL')`,
        [],
        'sales_orders_values_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX sales_orders_number_unique ON sales_orders (tenant_id, series_id, number)
      WHERE number IS NOT NULL`)
    this.schema
      .raw(`CREATE UNIQUE INDEX sales_orders_quote_unique ON sales_orders (tenant_id, quote_id)
      WHERE quote_id IS NOT NULL`)
    // O orçamento convertido aponta para a encomenda (a FK chega agora que a tabela existe).
    this.schema.raw(`ALTER TABLE sales_quotes ADD CONSTRAINT sales_quotes_converted_order_fk
      FOREIGN KEY (tenant_id, converted_order_id) REFERENCES sales_orders (tenant_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'sales_order_lines', (table) => {
      table.uuid('order_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.string('description', 300).notNullable()
      table.boolean('is_stock').notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('reserved_qty', 18, 6).notNullable().defaultTo(0)
      table.decimal('delivered_qty', 18, 6).notNullable().defaultTo(0)
      table.decimal('invoiced_qty', 18, 6).notNullable().defaultTo(0)
      table.decimal('closed_qty', 18, 6).notNullable().defaultTo(0)
      table.decimal('manual_discount_pct', 5, 2).nullable()
      table.decimal('manual_unit_price', 20, 4).nullable()
      table.decimal('tax_rate', 5, 2).notNullable()
      table.string('tax_exemption_reason', 300).nullable()
      table.string('price_source', 10).notNullable()
      table.decimal('base_price', 20, 4).nullable()
      table.decimal('net_unit_price', 20, 4).nullable()
      table.decimal('net_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('tax_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('gross_amount', 20, 2).notNullable().defaultTo(0)
      table.boolean('requires_approval').notNullable().defaultTo(false)
      table.jsonb('pricing').notNullable()
      table.integer('quote_line_no').nullable()
      tenantForeignKey(table, 'order_id', 'sales_orders')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.unique(['tenant_id', 'order_id', 'line_no'], {
        indexName: 'sales_order_lines_no_unique',
      })
      table.check(
        `quantity > 0 AND reserved_qty >= 0 AND delivered_qty >= 0 AND invoiced_qty >= 0 AND closed_qty >= 0
         AND delivered_qty + reserved_qty + closed_qty <= quantity AND invoiced_qty <= quantity
         AND (is_stock OR reserved_qty = 0)
         AND tax_rate BETWEEN 0 AND 100 AND (tax_rate > 0 OR tax_exemption_reason IS NOT NULL)
         AND NOT (manual_discount_pct IS NOT NULL AND manual_unit_price IS NOT NULL)
         AND price_source IN ('LIST','CATALOG','MANUAL','NONE','QUOTE')
         AND net_amount >= 0 AND tax_amount >= 0 AND gross_amount = net_amount + tax_amount`,
        [],
        'sales_order_lines_values_check'
      )
    })

    createTenantTable(this, 'sales_order_deliveries', (table) => {
      table.uuid('order_id').notNullable()
      table.integer('seq').notNullable()
      table.string('reference', 80).notNullable()
      table.string('request_key', 100).notNullable()
      table.string('request_hash', 64).notNullable()
      table.date('delivery_date').notNullable()
      table.uuid('warehouse_id').nullable()
      table.uuid('stock_event_id').nullable()
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'order_id', 'sales_orders')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      table.unique(['tenant_id', 'order_id', 'seq'], {
        indexName: 'sales_order_deliveries_seq_unique',
      })
      table.unique(['tenant_id', 'order_id', 'request_key'], {
        indexName: 'sales_order_deliveries_key_unique',
      })
    })
    createTenantTable(this, 'sales_order_delivery_lines', (table) => {
      table.uuid('delivery_id').notNullable()
      table.uuid('order_line_id').notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      tenantForeignKey(table, 'delivery_id', 'sales_order_deliveries')
      tenantForeignKey(table, 'order_line_id', 'sales_order_lines')
      table.check('quantity > 0', [], 'sales_order_delivery_lines_qty_check')
    })

    createTenantTable(this, 'sales_order_events', (table) => {
      table.uuid('order_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'order_id', 'sales_orders')
      table.index(['tenant_id', 'order_id'], 'sales_order_events_order_index')
    })

    for (const t of [
      'sales_order_deliveries',
      'sales_order_delivery_lines',
      'sales_order_events',
    ]) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    const header = [
      'legal_entity_id',
      'customer_id',
      'salesperson_membership_id',
      'quote_id',
      'order_date',
      'currency',
      'payment_terms_days',
      'customer_reference',
      'net_total',
      'tax_total',
      'gross_total',
      'pricing_hash',
    ]
      .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
      .join(' OR ')
    this.schema.raw(`
      CREATE FUNCTION sales_orders_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'DRAFT' AND (${header}) THEN
          RAISE EXCEPTION 'ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.number IS NOT NULL AND (NEW.number IS DISTINCT FROM OLD.number OR NEW.series_id IS DISTINCT FROM OLD.series_id) THEN
          RAISE EXCEPTION 'ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('CLOSED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
          RAISE EXCEPTION 'ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'CONFIRMED' AND NEW.status = 'DRAFT' THEN
          RAISE EXCEPTION 'ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_orders_fixed BEFORE UPDATE OR DELETE
      ON sales_orders FOR EACH ROW EXECUTE FUNCTION sales_orders_fixed()`)

    // Linhas: em rascunho mudam livremente; depois só as quantidades do cumprimento (reservada, entregue, facturada,
    // fechada) — nunca o preço, o produto ou a quantidade encomendada — e não se apagam.
    const content = [
      'order_id',
      'line_no',
      'product_id',
      'variant_id',
      'description',
      'is_stock',
      'quantity',
      'manual_discount_pct',
      'manual_unit_price',
      'tax_rate',
      'tax_exemption_reason',
      'price_source',
      'base_price',
      'net_unit_price',
      'net_amount',
      'tax_amount',
      'gross_amount',
      'pricing',
    ]
      .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
      .join(' OR ')
    this.schema.raw(`
      CREATE FUNCTION sales_order_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM sales_orders
         WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.order_id, OLD.order_id);
        IF s = 'DRAFT' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF TG_OP <> 'UPDATE' OR (${content}) THEN
          RAISE EXCEPTION 'ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_order_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON sales_order_lines FOR EACH ROW EXECUTE FUNCTION sales_order_lines_fixed()`)
  }

  async down() {
    this.schema.raw(`ALTER TABLE sales_quotes DROP CONSTRAINT sales_quotes_converted_order_fk`)
    this.schema.dropTable('sales_order_events')
    this.schema.dropTable('sales_order_delivery_lines')
    this.schema.dropTable('sales_order_deliveries')
    this.schema.dropTable('sales_order_lines')
    this.schema.dropTable('sales_orders')
    for (const f of [
      'sales_order_deliveries_fixed',
      'sales_order_delivery_lines_fixed',
      'sales_order_events_fixed',
      'sales_orders_fixed',
      'sales_order_lines_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
