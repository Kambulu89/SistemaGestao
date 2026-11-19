import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Facturas de fornecedor e conferência a três (Prompt 09, bloco 9.8).
 *
 *  - `procurement_tolerances`: tolerâncias da conferência, uma linha por empresa (preço: percentagem ou valor por
 *    linha; quantidade: percentagem acima do recebido; total: diferença entre o declarado e a soma das linhas).
 *  - `purchase_invoices`: a factura do fornecedor sobre uma ordem — número externo (único por fornecedor, fora as
 *    anuladas), data, vencimento, moeda (a da ordem), total declarado, totais calculados, câmbio e total funcional
 *    (fixados na validação), número interno (série `PURCHASE_INVOICE`), divergências da última conferência e estado
 *    (rascunho → validada, ou → com excepção pendente → validada por autorização de outra pessoa | de volta a rascunho;
 *    recusada e anulada finais).
 *  - `purchase_invoice_lines`: por linha da ordem (ou encargo sem linha), quantidade, preço, desconto, imposto e
 *    valores exactos, com a fotografia da conferência (encomendado, recebido, já facturado, preço da ordem, resultado).
 *  - `purchase_invoice_exceptions`: decisões sobre as divergências (só acréscimo; quem decide ≠ quem pediu).
 *  - `purchase_invoice_events`: histórico (só acréscimo).
 *  Validada, a factura não muda (corrige-se por nota de crédito, 9.9); nunca se apaga.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'procurement_tolerances', (table) => {
      table.decimal('price_pct', 6, 3).notNullable().defaultTo(0)
      table.decimal('price_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('qty_pct', 6, 3).notNullable().defaultTo(0)
      table.decimal('total_amount', 20, 2).notNullable().defaultTo(0)
      table.unique(['tenant_id'], { indexName: 'procurement_tolerances_tenant_unique' })
      table.check(
        'price_pct BETWEEN 0 AND 100 AND qty_pct BETWEEN 0 AND 100 AND price_amount >= 0 AND total_amount >= 0',
        [],
        'procurement_tolerances_values_check'
      )
    })

    createTenantTable(this, 'purchase_invoices', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.uuid('order_id').notNullable()
      table.string('invoice_number', 60).notNullable()
      table.string('invoice_number_key', 60).notNullable()
      table.date('invoice_date').notNullable()
      table.date('due_date').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('declared_total', 20, 2).notNullable()
      table.decimal('total_net', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_tax', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('exchange_rate', 20, 10).nullable()
      table.decimal('total_functional', 20, 2).nullable()
      table.text('notes').nullable()
      table.jsonb('divergences').nullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('submitted_by').nullable()
      table.timestamp('validated_at', { useTz: true }).nullable()
      table.uuid('validated_by').nullable()
      table.string('reject_reason', 500).nullable()
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'purchase_invoices_number_unique',
      })
      table.index(['tenant_id', 'order_id'], 'purchase_invoices_order_index')
      table.check(
        `status IN ('DRAFT','PENDING_EXCEPTION','VALIDATED','REJECTED','CANCELLED')`,
        [],
        'purchase_invoices_status_check'
      )
      table.check(
        `status <> 'VALIDATED' OR (number IS NOT NULL AND validated_at IS NOT NULL AND exchange_rate IS NOT NULL
           AND total_functional IS NOT NULL)`,
        [],
        'purchase_invoices_validated_check'
      )
      table.check(
        `status <> 'PENDING_EXCEPTION' OR (submitted_at IS NOT NULL AND submitted_by IS NOT NULL AND divergences IS NOT NULL)`,
        [],
        'purchase_invoices_pending_check'
      )
      table.check(
        `status <> 'REJECTED' OR reject_reason IS NOT NULL`,
        [],
        'purchase_invoices_reject_check'
      )
      table.check(
        `status <> 'CANCELLED' OR cancel_reason IS NOT NULL`,
        [],
        'purchase_invoices_cancel_check'
      )
      table.check(
        `due_date >= invoice_date AND declared_total >= 0 AND total_amount = total_net + total_tax`,
        [],
        'purchase_invoices_values_check'
      )
    })
    // O mesmo número externo do mesmo fornecedor só uma vez (as anuladas não contam).
    this.schema.raw(`CREATE UNIQUE INDEX purchase_invoices_external_unique ON purchase_invoices
      (tenant_id, supplier_id, invoice_number_key) WHERE status <> 'CANCELLED'`)

    createTenantTable(this, 'purchase_invoice_lines', (table) => {
      table.uuid('invoice_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('order_line_id').nullable()
      table.string('description', 300).notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('unit_price', 20, 6).notNullable()
      table.decimal('discount_rate', 6, 3).notNullable().defaultTo(0)
      table.decimal('tax_rate', 6, 3).notNullable().defaultTo(0)
      table.decimal('gross_amount', 20, 2).notNullable()
      table.decimal('discount_amount', 20, 2).notNullable()
      table.decimal('net_amount', 20, 2).notNullable()
      table.decimal('tax_amount', 20, 2).notNullable()
      table.decimal('total_amount', 20, 2).notNullable()
      table.jsonb('match').nullable()
      tenantForeignKey(table, 'invoice_id', 'purchase_invoices')
      tenantForeignKey(table, 'order_line_id', 'purchase_order_lines')
      table.unique(['tenant_id', 'invoice_id', 'line_no'], {
        indexName: 'purchase_invoice_lines_no_unique',
      })
      table.check(
        'quantity > 0 AND unit_price >= 0 AND discount_rate BETWEEN 0 AND 100 AND tax_rate BETWEEN 0 AND 100',
        [],
        'purchase_invoice_lines_values_check'
      )
      table.check(
        `net_amount = gross_amount - discount_amount AND total_amount = net_amount + tax_amount
         AND discount_amount >= 0 AND tax_amount >= 0`,
        [],
        'purchase_invoice_lines_totals_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX purchase_invoice_lines_order_line_unique ON purchase_invoice_lines
      (tenant_id, invoice_id, order_line_id) WHERE order_line_id IS NOT NULL`)

    createTenantTable(this, 'purchase_invoice_exceptions', (table) => {
      table.uuid('invoice_id').notNullable()
      table.string('decision', 8).notNullable()
      table.jsonb('divergences').notNullable()
      table.string('reason', 500).notNullable()
      table.uuid('requested_by').notNullable()
      table.uuid('decided_by').notNullable()
      tenantForeignKey(table, 'invoice_id', 'purchase_invoices')
      table.check(
        `decision IN ('APPROVE','REJECT')`,
        [],
        'purchase_invoice_exceptions_decision_check'
      )
      table.check('decided_by <> requested_by', [], 'purchase_invoice_exceptions_segregation_check')
    })

    createTenantTable(this, 'purchase_invoice_events', (table) => {
      table.uuid('invoice_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'invoice_id', 'purchase_invoices')
      table.index(['tenant_id', 'invoice_id'], 'purchase_invoice_events_invoice_index')
    })

    for (const t of ['purchase_invoice_exceptions', 'purchase_invoice_events']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Factura: rascunho livre; com excepção pendente só a decisão ou a anulação; validada, recusada e anulada finais.
    this.schema.raw(`
      CREATE FUNCTION purchase_invoices_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status IN ('VALIDATED','REJECTED','CANCELLED') THEN
          RAISE EXCEPTION 'PURCHASE_INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
           OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id THEN
          RAISE EXCEPTION 'PURCHASE_INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'PENDING_EXCEPTION' AND (
             NEW.invoice_number IS DISTINCT FROM OLD.invoice_number OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
             OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.declared_total IS DISTINCT FROM OLD.declared_total
             OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.divergences IS DISTINCT FROM OLD.divergences) THEN
          RAISE EXCEPTION 'PURCHASE_INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_invoices_fixed BEFORE UPDATE OR DELETE
      ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION purchase_invoices_fixed()`)

    // Linhas: só em rascunho (a fotografia da conferência grava-se em rascunho, antes de mudar de estado).
    this.schema.raw(`
      CREATE FUNCTION purchase_invoice_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE st text;
      BEGIN
        SELECT status INTO st FROM purchase_invoices WHERE id = COALESCE(OLD.invoice_id, NEW.invoice_id);
        IF st IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'PURCHASE_INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_invoice_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON purchase_invoice_lines FOR EACH ROW EXECUTE FUNCTION purchase_invoice_lines_fixed()`)
  }

  async down() {
    for (const t of [
      'purchase_invoice_events',
      'purchase_invoice_exceptions',
      'purchase_invoice_lines',
      'purchase_invoices',
      'procurement_tolerances',
    ])
      this.schema.dropTable(t)
    for (const f of [
      'purchase_invoices_fixed',
      'purchase_invoice_lines_fixed',
      'purchase_invoice_exceptions_fixed',
      'purchase_invoice_events_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
