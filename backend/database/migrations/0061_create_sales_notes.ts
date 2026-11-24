import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Notas de crédito e débito, devoluções físicas e reembolsos (Prompt 10, bloco 10.8) — módulo `sales`. Três coisas
 * distintas, cada uma com o seu documento:
 *
 *  - **devolução física** (`sales_returns`): mercadoria que volta ao armazém a partir de uma encomenda expedida (entra
 *    pelo contrato `returnFromSale` do Inventário). Não mexe em valores nem em impostos;
 *  - **correcção fiscal** (`sales_notes`): nota de crédito ou débito que referencia a factura original, com motivo e
 *    linhas elegíveis (quantidade ou valor) e o imposto das linhas originais; numerada pela série fiscal em simulação,
 *    imutável depois de emitida. A nota de crédito abate a factura (até ao que falta) e o resto fica como crédito do
 *    cliente; a de débito aumenta o valor em dívida da factura;
 *  - **reembolso financeiro** (`sales_refunds`): devolução de dinheiro a partir do crédito de uma nota, que só conta
 *    depois da confirmação por outra pessoa.
 *
 * A factura ganha `credited_total` e `debited_total` (nunca descem): o valor em dívida é
 * `payable_total + debited_total − credited_total − paid_total`.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`ALTER TABLE sales_invoices
      ADD COLUMN credited_total numeric(20,2) NOT NULL DEFAULT 0,
      ADD COLUMN debited_total numeric(20,2) NOT NULL DEFAULT 0`)
    this.schema.raw(`ALTER TABLE sales_invoices DROP CONSTRAINT sales_invoices_values_check`)
    this.schema.raw(`ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_values_check CHECK (
         payment_terms_days BETWEEN 0 AND 365
         AND net_total >= 0 AND tax_total >= 0 AND withholding_total >= 0 AND paid_total >= 0
         AND credited_total >= 0 AND debited_total >= 0
         AND gross_total = net_total + tax_total AND payable_total = gross_total - withholding_total
         AND paid_total + credited_total <= payable_total + debited_total
         AND (exchange_rate IS NULL OR exchange_rate > 0)
         AND ((status IN ('ISSUED','CORRECTED')) = (number IS NOT NULL))
         AND (status NOT IN ('ISSUED','CORRECTED') OR (series_id IS NOT NULL AND fiscal_number IS NOT NULL
              AND customer_version_id IS NOT NULL AND customer_snapshot IS NOT NULL AND due_date IS NOT NULL
              AND exchange_rate IS NOT NULL AND functional_currency IS NOT NULL AND fiscal_status IS NOT NULL
              AND collection_status IS NOT NULL AND document_hash IS NOT NULL AND issued_at IS NOT NULL))
         AND (status <> 'DISCARDED' OR discard_reason IS NOT NULL)
         AND (due_date IS NULL OR due_date >= invoice_date)
         AND (status IN ('ISSUED','CORRECTED') OR (credited_total = 0 AND debited_total = 0)))`)
    this.schema.raw(`
      CREATE FUNCTION sales_invoices_adjust_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.credited_total < OLD.credited_total OR NEW.debited_total < OLD.debited_total THEN
          RAISE EXCEPTION 'ADJUSTMENT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_invoices_adjust_fixed BEFORE UPDATE ON sales_invoices
      FOR EACH ROW EXECUTE FUNCTION sales_invoices_adjust_fixed()`)

    // ---- Devolução física -----------------------------------------------------------------------------------------
    // Devolvido e, desse, já creditado por nota ligada à devolução (volta a poder facturar-se o que a nota anulou).
    this.schema
      .raw(`ALTER TABLE sales_order_lines ADD COLUMN returned_qty numeric(18,6) NOT NULL DEFAULT 0,
      ADD COLUMN return_credited_qty numeric(18,6) NOT NULL DEFAULT 0`)
    this.schema.raw(`ALTER TABLE sales_order_lines ADD CONSTRAINT sales_order_lines_returned_check
      CHECK (returned_qty >= 0 AND returned_qty <= delivered_qty AND return_credited_qty >= 0
             AND return_credited_qty <= returned_qty AND return_credited_qty <= invoiced_qty)`)

    createTenantTable(this, 'sales_returns', (table) => {
      table.uuid('order_id').notNullable()
      table.integer('seq').notNullable()
      table.string('reference', 80).notNullable()
      table.string('request_key', 100).notNullable()
      table.string('request_hash', 64).notNullable()
      table.date('return_date').notNullable()
      table.uuid('warehouse_id').nullable()
      table.uuid('stock_event_id').nullable()
      table.string('reason', 500).notNullable()
      tenantForeignKey(table, 'order_id', 'sales_orders')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      table.unique(['tenant_id', 'order_id', 'seq'], { indexName: 'sales_returns_seq_unique' })
      table.unique(['tenant_id', 'order_id', 'request_key'], {
        indexName: 'sales_returns_key_unique',
      })
    })
    createTenantTable(this, 'sales_return_lines', (table) => {
      table.uuid('return_id').notNullable()
      table.uuid('order_line_id').notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      tenantForeignKey(table, 'return_id', 'sales_returns')
      tenantForeignKey(table, 'order_line_id', 'sales_order_lines')
      table.unique(['tenant_id', 'return_id', 'order_line_id'], {
        indexName: 'sales_return_lines_unique',
      })
      table.check('quantity > 0', [], 'sales_return_lines_qty_check')
    })

    // ---- Notas de crédito e débito --------------------------------------------------------------------------------
    createTenantTable(this, 'sales_notes', (table) => {
      table.string('kind', 6).notNullable()
      table.uuid('invoice_id').notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.uuid('return_id').nullable()
      table.string('reason_code', 20).notNullable()
      table.string('reason', 500).notNullable()
      table.date('note_date').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.specificType('functional_currency', 'char(3)').notNullable()
      table.decimal('exchange_rate', 24, 10).notNullable()
      table.uuid('customer_version_id').notNullable()
      table.jsonb('customer_snapshot').notNullable()
      table.string('rounding_level', 10).notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('fiscal_status', 12).nullable()
      table.uuid('series_id').nullable()
      table.integer('fiscal_number').nullable()
      table.string('number', 60).nullable()
      table.decimal('net_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('tax_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('gross_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('withholding_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('payable_total', 20, 2).notNullable().defaultTo(0)
      table.jsonb('tax_summary').nullable()
      table.decimal('applied_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('refunded_total', 20, 2).notNullable().defaultTo(0)
      table.string('document_hash', 64).nullable()
      table.uuid('issued_by').nullable()
      table.timestamp('issued_at', { useTz: true }).nullable()
      table.string('discard_reason', 500).nullable()
      tenantForeignKey(table, 'invoice_id', 'sales_invoices')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'return_id', 'sales_returns')
      tenantForeignKey(table, 'customer_version_id', 'customer_versions')
      tenantForeignKey(table, 'series_id', 'fiscal_series')
      table.index(['tenant_id', 'invoice_id'], 'sales_notes_invoice_index')
      table.index(['tenant_id', 'customer_id', 'status'], 'sales_notes_customer_index')
      table.check(
        `kind IN ('CREDIT','DEBIT') AND status IN ('DRAFT','ISSUED','DISCARDED')
         AND (fiscal_status IS NULL OR fiscal_status IN ('PENDING','ACCEPTED','REJECTED','CONTINGENCY'))
         AND rounding_level IN ('LINE','DOCUMENT') AND exchange_rate > 0
         AND net_total >= 0 AND tax_total >= 0 AND withholding_total >= 0
         AND gross_total = net_total + tax_total AND payable_total = gross_total - withholding_total
         AND applied_total >= 0 AND refunded_total >= 0 AND applied_total + refunded_total <= payable_total
         AND (kind = 'CREDIT' OR (applied_total = 0 AND refunded_total = 0 AND return_id IS NULL))
         AND (status = 'ISSUED' OR (applied_total = 0 AND refunded_total = 0))
         AND ((status = 'ISSUED') = (number IS NOT NULL))
         AND (status <> 'ISSUED' OR (series_id IS NOT NULL AND fiscal_number IS NOT NULL AND fiscal_status IS NOT NULL
              AND document_hash IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL AND net_total > 0))
         AND (kind <> 'CREDIT' OR issued_by IS NULL OR issued_by <> created_by)
         AND (status <> 'DISCARDED' OR discard_reason IS NOT NULL)
         AND length(reason) >= 3`,
        [],
        'sales_notes_values_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX sales_notes_number_unique ON sales_notes (tenant_id, series_id, fiscal_number)
      WHERE fiscal_number IS NOT NULL`)

    createTenantTable(this, 'sales_note_lines', (table) => {
      table.uuid('note_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('invoice_line_id').notNullable()
      table.string('mode', 8).notNullable()
      table.decimal('quantity', 18, 6).nullable()
      table.string('description', 300).notNullable()
      table.decimal('net_amount', 20, 2).notNullable()
      table.decimal('tax_amount', 20, 6).notNullable().defaultTo(0)
      table.jsonb('taxes').nullable()
      tenantForeignKey(table, 'note_id', 'sales_notes')
      tenantForeignKey(table, 'invoice_line_id', 'sales_invoice_lines')
      table.unique(['tenant_id', 'note_id', 'line_no'], { indexName: 'sales_note_lines_no_unique' })
      table.unique(['tenant_id', 'note_id', 'invoice_line_id'], {
        indexName: 'sales_note_lines_line_unique',
      })
      table.check(
        `mode IN ('QUANTITY','VALUE') AND net_amount > 0 AND tax_amount >= 0
         AND ((mode = 'QUANTITY') = (quantity IS NOT NULL)) AND (quantity IS NULL OR quantity > 0)`,
        [],
        'sales_note_lines_values_check'
      )
    })

    // Crédito da nota aplicado a facturas (a original na emissão; outras depois) — só de acréscimo.
    createTenantTable(this, 'sales_note_applications', (table) => {
      table.uuid('note_id').notNullable()
      table.uuid('invoice_id').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      tenantForeignKey(table, 'note_id', 'sales_notes')
      tenantForeignKey(table, 'invoice_id', 'sales_invoices')
      table.index(['tenant_id', 'note_id'], 'sales_note_applications_note_index')
      table.index(['tenant_id', 'invoice_id'], 'sales_note_applications_invoice_index')
      table.check('amount > 0', [], 'sales_note_applications_amount_check')
    })

    // ---- Reembolso financeiro -------------------------------------------------------------------------------------
    createTenantTable(this, 'sales_refunds', (table) => {
      table.uuid('note_id').notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      table.string('method', 10).notNullable()
      table.uuid('bank_account_id').nullable()
      table.string('reference', 80).nullable()
      table.date('refund_date').notNullable()
      table.string('request_key', 80).notNullable()
      table.string('request_hash', 64).notNullable()
      table.string('status', 12).notNullable().defaultTo('PENDING')
      table.uuid('confirmed_by').nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.string('decision_reason', 500).nullable()
      tenantForeignKey(table, 'note_id', 'sales_notes')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'bank_account_id', 'bank_accounts')
      table.unique(['tenant_id', 'note_id', 'request_key'], {
        indexName: 'sales_refunds_key_unique',
      })
      table.check(
        `status IN ('PENDING','CONFIRMED','REJECTED','CANCELLED')
         AND method IN ('CASH','TRANSFER','CARD','CHEQUE','OTHER') AND amount > 0
         AND (status <> 'CONFIRMED' OR confirmed_by IS NOT NULL)
         AND (confirmed_by IS NULL OR confirmed_by <> created_by)
         AND (status NOT IN ('REJECTED','CANCELLED') OR decision_reason IS NOT NULL)`,
        [],
        'sales_refunds_values_check'
      )
    })

    // ---- Imutabilidade --------------------------------------------------------------------------------------------
    for (const t of ['sales_returns', 'sales_return_lines', 'sales_note_applications']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }
    const content = [
      'kind',
      'invoice_id',
      'legal_entity_id',
      'customer_id',
      'return_id',
      'reason_code',
      'reason',
      'note_date',
      'currency',
      'functional_currency',
      'exchange_rate',
      'customer_version_id',
      'customer_snapshot',
      'rounding_level',
      'series_id',
      'fiscal_number',
      'number',
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
      CREATE FUNCTION sales_notes_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'ISSUED' AND (NEW.status <> 'ISSUED' OR ${content}) THEN
          RAISE EXCEPTION 'NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DISCARDED' THEN
          RAISE EXCEPTION 'NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.applied_total < OLD.applied_total OR NEW.refunded_total < OLD.refunded_total THEN
          RAISE EXCEPTION 'NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_notes_fixed BEFORE UPDATE OR DELETE
      ON sales_notes FOR EACH ROW EXECUTE FUNCTION sales_notes_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION sales_note_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM sales_notes
         WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.note_id, OLD.note_id);
        IF s IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.note_id IS DISTINCT FROM OLD.note_id THEN
          RAISE EXCEPTION 'NOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_note_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON sales_note_lines FOR EACH ROW EXECUTE FUNCTION sales_note_lines_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION sales_refunds_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'REFUND_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'PENDING' OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.note_id IS DISTINCT FROM OLD.note_id
           OR NEW.currency IS DISTINCT FROM OLD.currency THEN
          RAISE EXCEPTION 'REFUND_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_refunds_fixed BEFORE UPDATE OR DELETE
      ON sales_refunds FOR EACH ROW EXECUTE FUNCTION sales_refunds_fixed()`)
  }

  async down() {
    this.schema.dropTable('sales_refunds')
    this.schema.dropTable('sales_note_applications')
    this.schema.dropTable('sales_note_lines')
    this.schema.dropTable('sales_notes')
    this.schema.dropTable('sales_return_lines')
    this.schema.dropTable('sales_returns')
    for (const f of [
      'sales_refunds_fixed',
      'sales_note_lines_fixed',
      'sales_notes_fixed',
      'sales_note_applications_fixed',
      'sales_return_lines_fixed',
      'sales_returns_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
    this.schema.raw(
      `ALTER TABLE sales_order_lines DROP CONSTRAINT sales_order_lines_returned_check`
    )
    this.schema.raw(
      `ALTER TABLE sales_order_lines DROP COLUMN returned_qty, DROP COLUMN return_credited_qty`
    )
    this.schema.raw(`DROP TRIGGER sales_invoices_adjust_fixed ON sales_invoices`)
    this.schema.raw(`DROP FUNCTION sales_invoices_adjust_fixed()`)
    this.schema.raw(`ALTER TABLE sales_invoices DROP CONSTRAINT sales_invoices_values_check`)
    this.schema.raw(`ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_values_check CHECK (
         payment_terms_days BETWEEN 0 AND 365
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
         AND (due_date IS NULL OR due_date >= invoice_date))`)
    this.schema.raw(
      `ALTER TABLE sales_invoices DROP COLUMN credited_total, DROP COLUMN debited_total`
    )
  }
}
