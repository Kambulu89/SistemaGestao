import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recibos, factura-recibo e adiantamentos (Prompt 10, bloco 10.7) — módulo `sales`.
 *
 *  - `sales_invoices.document_kind`: factura ou factura-recibo (fixo depois da emissão).
 *  - `sales_receipts`: recebimento registado (valor, meio, conta bancária, referência, data-valor) que só conta depois
 *    da confirmação financeira por outra pessoa; então afecta as facturas, recebe número fiscal (série de recibos em
 *    simulação) e o excedente fica como adiantamento. Para a factura-recibo, a confirmação emite-a.
 *  - `sales_receipt_allocations`: afectação do recibo a facturas (aplicada na confirmação).
 *  - `sales_advance_applications`: uso posterior do adiantamento em facturas (só de acréscimo; nunca acima do saldo).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(
      `ALTER TABLE sales_invoices ADD COLUMN document_kind varchar(20) NOT NULL DEFAULT 'INVOICE'`
    )
    this.schema.raw(`ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_kind_check
      CHECK (document_kind IN ('INVOICE','INVOICE_RECEIPT'))`)
    this.schema.raw(`
      CREATE FUNCTION sales_invoices_kind_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status <> 'DRAFT' AND NEW.document_kind IS DISTINCT FROM OLD.document_kind THEN
          RAISE EXCEPTION 'INVOICE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.paid_total < OLD.paid_total THEN
          RAISE EXCEPTION 'PAYMENT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_invoices_kind_fixed BEFORE UPDATE ON sales_invoices
      FOR EACH ROW EXECUTE FUNCTION sales_invoices_kind_fixed()`)

    createTenantTable(this, 'sales_receipts', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.string('purpose', 20).notNullable()
      table.uuid('invoice_id').nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      table.string('method', 10).notNullable()
      table.uuid('bank_account_id').nullable()
      table.string('reference', 80).nullable()
      table.date('received_date').notNullable()
      table.string('request_key', 80).notNullable()
      table.string('request_hash', 64).notNullable()
      table.string('status', 12).notNullable().defaultTo('PENDING')
      table.uuid('series_id').nullable()
      table.integer('fiscal_number').nullable()
      table.string('number', 60).nullable()
      table.decimal('allocated_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('advance_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('advance_used', 20, 2).notNullable().defaultTo(0)
      table.uuid('confirmed_by').nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.string('decision_reason', 500).nullable()
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'invoice_id', 'sales_invoices')
      tenantForeignKey(table, 'bank_account_id', 'bank_accounts')
      tenantForeignKey(table, 'series_id', 'fiscal_series')
      table.unique(['tenant_id', 'legal_entity_id', 'request_key'], {
        indexName: 'sales_receipts_key_unique',
      })
      table.index(['tenant_id', 'customer_id', 'status'], 'sales_receipts_customer_index')
      table.check(
        `purpose IN ('RECEIPT','INVOICE_RECEIPT') AND (purpose = 'RECEIPT' OR invoice_id IS NOT NULL)
         AND status IN ('PENDING','CONFIRMED','REJECTED','CANCELLED')
         AND method IN ('CASH','TRANSFER','CARD','CHEQUE','OTHER')
         AND amount > 0 AND allocated_total >= 0 AND advance_total >= 0 AND advance_used >= 0
         AND allocated_total + advance_total <= amount AND advance_used <= advance_total
         AND (status <> 'CONFIRMED' OR (confirmed_by IS NOT NULL AND allocated_total + advance_total = amount))
         AND (confirmed_by IS NULL OR confirmed_by <> created_by)
         AND (status NOT IN ('REJECTED','CANCELLED') OR decision_reason IS NOT NULL)
         AND ((number IS NULL) = (fiscal_number IS NULL))`,
        [],
        'sales_receipts_values_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX sales_receipts_number_unique ON sales_receipts (tenant_id, series_id, fiscal_number)
      WHERE fiscal_number IS NOT NULL`)
    this.schema
      .raw(`CREATE UNIQUE INDEX sales_receipts_fr_unique ON sales_receipts (tenant_id, invoice_id)
      WHERE purpose = 'INVOICE_RECEIPT' AND status IN ('PENDING','CONFIRMED')`)

    createTenantTable(this, 'sales_receipt_allocations', (table) => {
      table.uuid('receipt_id').notNullable()
      table.uuid('invoice_id').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      tenantForeignKey(table, 'receipt_id', 'sales_receipts')
      tenantForeignKey(table, 'invoice_id', 'sales_invoices')
      table.unique(['tenant_id', 'receipt_id', 'invoice_id'], {
        indexName: 'sales_receipt_allocations_unique',
      })
      table.check('amount > 0', [], 'sales_receipt_allocations_amount_check')
    })

    createTenantTable(this, 'sales_advance_applications', (table) => {
      table.uuid('receipt_id').notNullable()
      table.uuid('invoice_id').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      tenantForeignKey(table, 'receipt_id', 'sales_receipts')
      tenantForeignKey(table, 'invoice_id', 'sales_invoices')
      table.index(['tenant_id', 'receipt_id'], 'sales_advance_applications_receipt_index')
      table.check('amount > 0', [], 'sales_advance_applications_amount_check')
    })

    for (const t of ['sales_receipt_allocations', 'sales_advance_applications']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE s text;
        BEGIN
          ${
            t === 'sales_receipt_allocations'
              ? `SELECT status INTO s FROM sales_receipts WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
                   AND id = COALESCE(NEW.receipt_id, OLD.receipt_id);
                 IF TG_OP = 'INSERT' AND s = 'PENDING' THEN RETURN NEW; END IF;`
              : `IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;`
          }
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE INSERT OR UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Recibo: confirmado não volta atrás nem muda de valor ou afectações; recusado e anulado são finais.
    this.schema.raw(`
      CREATE FUNCTION sales_receipts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'RECEIPT_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'PENDING' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.amount IS DISTINCT FROM OLD.amount
            OR NEW.allocated_total IS DISTINCT FROM OLD.allocated_total OR NEW.advance_total IS DISTINCT FROM OLD.advance_total
            OR NEW.number IS DISTINCT FROM OLD.number OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
            OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.received_date IS DISTINCT FROM OLD.received_date) THEN
          RAISE EXCEPTION 'RECEIPT_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.advance_used < OLD.advance_used THEN
          RAISE EXCEPTION 'RECEIPT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_receipts_fixed BEFORE UPDATE OR DELETE
      ON sales_receipts FOR EACH ROW EXECUTE FUNCTION sales_receipts_fixed()`)
  }

  async down() {
    this.schema.dropTable('sales_advance_applications')
    this.schema.dropTable('sales_receipt_allocations')
    this.schema.dropTable('sales_receipts')
    for (const f of [
      'sales_advance_applications_fixed',
      'sales_receipt_allocations_fixed',
      'sales_receipts_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
    this.schema.raw(`DROP TRIGGER sales_invoices_kind_fixed ON sales_invoices`)
    this.schema.raw(`DROP FUNCTION sales_invoices_kind_fixed()`)
    this.schema.raw(`ALTER TABLE sales_invoices DROP CONSTRAINT sales_invoices_kind_check`)
    this.schema.raw(`ALTER TABLE sales_invoices DROP COLUMN document_kind`)
  }
}
