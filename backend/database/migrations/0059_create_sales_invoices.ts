import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Facturas de venda (Prompt 10, bloco 10.6) — módulo `sales`. Emissão DEMONSTRATIVA: a numeração vem de séries
 * fiscais em modo de simulação (10.5); nada é comunicado à AGT.
 *
 *  - `sales_invoices`: entidade emitente e estabelecimento, série e número, cliente com a fotografia dos dados fiscais
 *    usados (versão imutável + NIF/morada), data e vencimento, moeda e câmbio para a moeda funcional, condições,
 *    origem (encomenda), totais e resumo dos impostos. Três estados distintos: negócio (rascunho, emitida, corrigida,
 *    descartada), fiscal (pendente, aceite, rejeitada, contingência — 10.9) e cobrança (por pagar, parcial, paga;
 *    vencida calcula-se na leitura). Impressão digital do conteúdo emitido (controlo interno, não é a assinatura AGT).
 *  - `sales_invoice_lines`: produto, quantidade, unidade, preço, descontos, impostos (códigos, taxas, isenção) e
 *    valores; a linha da encomenda de origem.
 *  - `sales_invoice_events`: cronologia (só de acréscimo).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'sales_invoices', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.uuid('customer_id').notNullable()
      table.uuid('customer_version_id').nullable()
      table.jsonb('customer_snapshot').nullable()
      table.uuid('order_id').nullable()
      table.uuid('series_id').nullable()
      table.integer('fiscal_number').nullable()
      table.string('number', 60).nullable()
      table.date('invoice_date').notNullable()
      table.date('due_date').nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.specificType('functional_currency', 'char(3)').nullable()
      table.decimal('exchange_rate', 24, 10).nullable()
      table.integer('payment_terms_days').notNullable().defaultTo(0)
      table.string('customer_reference', 60).nullable()
      table.string('notes', 2000).nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.string('fiscal_status', 12).nullable()
      table.string('collection_status', 10).nullable()
      table.string('rounding_level', 10).nullable()
      table.decimal('net_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('tax_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('gross_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('withholding_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('payable_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('paid_total', 20, 2).notNullable().defaultTo(0)
      table.jsonb('tax_summary').nullable()
      table.string('document_hash', 64).nullable()
      table.uuid('issued_by').nullable()
      table.timestamp('issued_at', { useTz: true }).nullable()
      table.string('discard_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'customer_version_id', 'customer_versions')
      tenantForeignKey(table, 'order_id', 'sales_orders')
      tenantForeignKey(table, 'series_id', 'fiscal_series')
      table.index(['tenant_id', 'legal_entity_id', 'status'], 'sales_invoices_entity_index')
      table.index(['tenant_id', 'customer_id', 'status'], 'sales_invoices_customer_index')
      table.index(['tenant_id', 'order_id'], 'sales_invoices_order_index')
      table.check(
        `status IN ('DRAFT','ISSUED','CORRECTED','DISCARDED')`,
        [],
        'sales_invoices_status_check'
      )
      table.check(
        `(fiscal_status IS NULL OR fiscal_status IN ('PENDING','ACCEPTED','REJECTED','CONTINGENCY'))
         AND (collection_status IS NULL OR collection_status IN ('UNPAID','PARTIAL','PAID'))
         AND (rounding_level IS NULL OR rounding_level IN ('LINE','DOCUMENT'))`,
        [],
        'sales_invoices_substatus_check'
      )
      table.check(
        `payment_terms_days BETWEEN 0 AND 365
         AND net_total >= 0 AND tax_total >= 0 AND withholding_total >= 0 AND paid_total >= 0
         AND gross_total = net_total + tax_total AND payable_total = gross_total - withholding_total
         AND paid_total <= payable_total
         AND (exchange_rate IS NULL OR exchange_rate > 0)
         AND ((status IN ('ISSUED','CORRECTED')) = (number IS NOT NULL))
         AND (status NOT IN ('ISSUED','CORRECTED') OR (series_id IS NOT NULL AND fiscal_number IS NOT NULL
              AND customer_version_id IS NOT NULL AND customer_snapshot IS NOT NULL AND due_date IS NOT NULL
              AND exchange_rate IS NOT NULL AND functional_currency IS NOT NULL AND fiscal_status IS NOT NULL
              AND collection_status IS NOT NULL AND document_hash IS NOT NULL AND issued_at IS NOT NULL))
         AND (status <> 'DISCARDED' OR discard_reason IS NOT NULL)
         AND (due_date IS NULL OR due_date >= invoice_date)`,
        [],
        'sales_invoices_values_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX sales_invoices_number_unique ON sales_invoices (tenant_id, series_id, fiscal_number)
      WHERE fiscal_number IS NOT NULL`)

    createTenantTable(this, 'sales_invoice_lines', (table) => {
      table.uuid('invoice_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.string('description', 300).notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.string('uom_code', 12).notNullable()
      table.decimal('manual_discount_pct', 5, 2).nullable()
      table.decimal('manual_unit_price', 20, 4).nullable()
      table.string('price_source', 10).notNullable()
      table.decimal('base_price', 20, 4).nullable()
      table.decimal('net_unit_price', 20, 4).nullable()
      table.decimal('discount_pct', 7, 4).notNullable().defaultTo(0)
      table.decimal('net_amount', 20, 2).notNullable().defaultTo(0)
      table.specificType('tax_code_ids', 'uuid[]').notNullable()
      table.string('exemption_code', 20).nullable()
      table.decimal('tax_amount', 20, 6).notNullable().defaultTo(0)
      table.jsonb('taxes').nullable()
      table.jsonb('pricing').notNullable()
      table.uuid('order_line_id').nullable()
      tenantForeignKey(table, 'invoice_id', 'sales_invoices')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'order_line_id', 'sales_order_lines')
      table.unique(['tenant_id', 'invoice_id', 'line_no'], {
        indexName: 'sales_invoice_lines_no_unique',
      })
      table.check(
        `quantity > 0 AND net_amount >= 0 AND tax_amount >= 0 AND cardinality(tax_code_ids) >= 1
         AND NOT (manual_discount_pct IS NOT NULL AND manual_unit_price IS NOT NULL)
         AND price_source IN ('LIST','CATALOG','MANUAL','NONE','ORDER')`,
        [],
        'sales_invoice_lines_values_check'
      )
    })

    createTenantTable(this, 'sales_invoice_events', (table) => {
      table.uuid('invoice_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'invoice_id', 'sales_invoices')
      table.index(['tenant_id', 'invoice_id'], 'sales_invoice_events_invoice_index')
    })
    this.schema.raw(`
      CREATE FUNCTION sales_invoice_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_invoice_events_fixed BEFORE UPDATE OR DELETE
      ON sales_invoice_events FOR EACH ROW EXECUTE FUNCTION sales_invoice_events_fixed()`)

    // Emitida é imutável: depois da emissão só mudam o estado fiscal, a cobrança (pago/estado) e a passagem a
    // corrigida; nunca se apaga nem volta a rascunho. Descartada é final.
    const content = [
      'legal_entity_id',
      'branch_id',
      'customer_id',
      'customer_version_id',
      'customer_snapshot',
      'order_id',
      'series_id',
      'fiscal_number',
      'number',
      'invoice_date',
      'due_date',
      'currency',
      'functional_currency',
      'exchange_rate',
      'payment_terms_days',
      'customer_reference',
      'notes',
      'rounding_level',
      'net_total',
      'tax_total',
      'gross_total',
      'withholding_total',
      'payable_total',
      'tax_summary',
      'document_hash',
      'issued_by',
      'issued_at',
    ]
      .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
      .join(' OR ')
    this.schema.raw(`
      CREATE FUNCTION sales_invoices_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('ISSUED','CORRECTED') AND (${content}) THEN
          RAISE EXCEPTION 'INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('ISSUED','CORRECTED') AND NEW.status NOT IN ('ISSUED','CORRECTED') THEN
          RAISE EXCEPTION 'INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'CORRECTED' AND NEW.status <> 'CORRECTED' THEN
          RAISE EXCEPTION 'INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DISCARDED' THEN
          RAISE EXCEPTION 'INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_invoices_fixed BEFORE UPDATE OR DELETE
      ON sales_invoices FOR EACH ROW EXECUTE FUNCTION sales_invoices_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION sales_invoice_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM sales_invoices
         WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.invoice_id, OLD.invoice_id);
        IF s IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
          RAISE EXCEPTION 'INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_invoice_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON sales_invoice_lines FOR EACH ROW EXECUTE FUNCTION sales_invoice_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('sales_invoice_events')
    this.schema.dropTable('sales_invoice_lines')
    this.schema.dropTable('sales_invoices')
    for (const f of [
      'sales_invoice_events_fixed',
      'sales_invoices_fixed',
      'sales_invoice_lines_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
