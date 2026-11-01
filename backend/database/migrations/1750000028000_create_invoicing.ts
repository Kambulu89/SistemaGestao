import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Contratos, facturas e notas de crédito (M05). Um documento emitido guarda o **instantâneo** do que foi facturado
 * (cliente, linhas, taxas, política de arredondamento) e deixa de se poder alterar — nem por SQL directo: as correcções
 * fazem-se por nota de crédito, que referencia linhas emitidas e nunca ultrapassa o que ainda é creditável (verificado
 * na aplicação sob bloqueio). Não há `VOID` nem certificação fiscal nesta fatia: `fiscal_status` fica `NOT_REQUIRED`.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'contracts', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('party_id').notNullable()
      table.string('type', 10).notNullable()
      table.string('title', 160).notNullable()
      table.string('number', 60).nullable()
      table.date('start_date').notNullable()
      table.date('end_date').nullable()
      table.string('currency', 3).notNullable()
      table.decimal('amount', 19, 4).nullable()
      table.string('renewal_mode', 10).notNullable().defaultTo('NONE')
      table.integer('notice_days').notNullable().defaultTo(0)
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('notes', 1000).nullable()
      table.timestamp('activated_at', { useTz: true }).nullable()
      table.timestamp('terminated_at', { useTz: true }).nullable()
      table.string('terminate_reason', 300).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'party_id', 'parties')
      table.index(['tenant_id', 'party_id'], 'contracts_party_index')
      table.index(['tenant_id', 'status'], 'contracts_status_index')
    })
    this.schema.raw(`
      ALTER TABLE contracts
        ADD CONSTRAINT contracts_type_check CHECK (type IN ('SALES', 'PURCHASE', 'SERVICE')),
        ADD CONSTRAINT contracts_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'TERMINATED')),
        ADD CONSTRAINT contracts_renewal_check CHECK (renewal_mode IN ('NONE', 'MANUAL', 'AUTO')),
        ADD CONSTRAINT contracts_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT contracts_amount_check CHECK (amount IS NULL OR amount >= 0),
        ADD CONSTRAINT contracts_notice_check CHECK (notice_days >= 0),
        ADD CONSTRAINT contracts_dates_check CHECK (end_date IS NULL OR end_date >= start_date),
        ADD CONSTRAINT contracts_number_check CHECK (status = 'DRAFT' OR number IS NOT NULL),
        ADD CONSTRAINT contracts_terminated_check
          CHECK ((status = 'TERMINATED') = (terminated_at IS NOT NULL AND terminate_reason IS NOT NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX contracts_number_unique ON contracts (tenant_id, number) WHERE number IS NOT NULL
    `)
    // Depois de activado, as partes, o tipo, o início e a moeda não mudam (o fim, a renovação e o aviso podem renegociar-se).
    this.schema.raw(`
      CREATE FUNCTION contracts_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'CONTRACT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
        IF OLD.status = 'TERMINATED' THEN RAISE EXCEPTION 'CONTRACT_IMMUTABLE' USING ERRCODE = '23000'; END IF;
        IF (NEW.tenant_id, NEW.organization_id, NEW.party_id, NEW.type, NEW.number, NEW.start_date, NEW.currency)
           IS NOT DISTINCT FROM
           (OLD.tenant_id, OLD.organization_id, OLD.party_id, OLD.type, OLD.number, OLD.start_date, OLD.currency) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'CONTRACT_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER contracts_guard BEFORE UPDATE OR DELETE ON contracts
        FOR EACH ROW EXECUTE FUNCTION contracts_guard()
    `)

    createTenantTable(this, 'invoices', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.uuid('contract_id').nullable()
      table.uuid('order_id').nullable()
      table.string('number', 60).nullable()
      table.date('issued_on').nullable()
      table.date('due_on').notNullable()
      table.string('currency', 3).notNullable()
      table.decimal('exchange_rate', 19, 6).notNullable().defaultTo(1)
      table.jsonb('customer_snapshot').nullable()
      table.string('rounding_mode', 10).nullable()
      table.decimal('net_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('tax_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('total', 19, 4).notNullable().defaultTo(0)
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('fiscal_status', 14).notNullable().defaultTo('NOT_REQUIRED')
      table.timestamp('issued_at', { useTz: true }).nullable()
      table.string('notes', 1000).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'contract_id', 'contracts')
      tenantForeignKey(table, 'order_id', 'sales_orders')
      table.index(['tenant_id', 'customer_id'], 'invoices_customer_index')
      table.index(['tenant_id', 'status'], 'invoices_status_index')
      table.index(['tenant_id', 'order_id'], 'invoices_order_index')
    })
    this.schema.raw(`
      ALTER TABLE invoices
        ADD CONSTRAINT invoices_status_check CHECK (status IN ('DRAFT', 'ISSUED', 'CREDITED')),
        ADD CONSTRAINT invoices_fiscal_check
          CHECK (fiscal_status IN ('NOT_REQUIRED', 'PENDING', 'ACCEPTED', 'REJECTED')),
        ADD CONSTRAINT invoices_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT invoices_rate_check CHECK (exchange_rate > 0),
        ADD CONSTRAINT invoices_totals_check
          CHECK (net_total >= 0 AND tax_total >= 0 AND total = net_total + tax_total),
        ADD CONSTRAINT invoices_issued_check CHECK (
          status = 'DRAFT'
          OR (number IS NOT NULL AND issued_on IS NOT NULL AND issued_at IS NOT NULL
              AND customer_snapshot IS NOT NULL AND rounding_mode IS NOT NULL AND due_on >= issued_on)
        )
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX invoices_number_unique ON invoices (tenant_id, number) WHERE number IS NOT NULL
    `)
    // Emitida, a factura só muda de ISSUED para CREDITED; tudo o resto fica como estava.
    this.schema.raw(`
      CREATE FUNCTION invoices_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'INVOICE_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
        IF OLD.status = 'ISSUED' AND NEW.status IN ('ISSUED', 'CREDITED')
           AND (NEW.tenant_id, NEW.organization_id, NEW.customer_id, NEW.contract_id, NEW.order_id, NEW.number,
                NEW.issued_on, NEW.due_on, NEW.currency, NEW.exchange_rate, NEW.customer_snapshot, NEW.rounding_mode,
                NEW.net_total, NEW.tax_total, NEW.total, NEW.fiscal_status, NEW.issued_at, NEW.notes)
              IS NOT DISTINCT FROM
              (OLD.tenant_id, OLD.organization_id, OLD.customer_id, OLD.contract_id, OLD.order_id, OLD.number,
               OLD.issued_on, OLD.due_on, OLD.currency, OLD.exchange_rate, OLD.customer_snapshot, OLD.rounding_mode,
               OLD.net_total, OLD.tax_total, OLD.total, OLD.fiscal_status, OLD.issued_at, OLD.notes) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'INVOICE_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices
        FOR EACH ROW EXECUTE FUNCTION invoices_guard()
    `)

    createTenantTable(this, 'invoice_lines', (table) => {
      table.uuid('invoice_id').notNullable()
      table.integer('position').notNullable()
      table.uuid('sales_order_line_id').nullable()
      table.uuid('variant_id').nullable()
      table.string('description', 500).notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.decimal('unit_price', 19, 4).notNullable()
      table.decimal('discount_amount', 19, 4).notNullable().defaultTo(0)
      table.string('tax_code', 50).notNullable()
      table.decimal('tax_rate', 9, 4).notNullable().defaultTo(0)
      table.string('exemption_reason', 300).nullable()
      table.decimal('net_amount', 19, 4).notNullable()
      table.decimal('tax_amount', 19, 4).notNullable()
      table.decimal('total', 19, 4).notNullable()
      tenantForeignKey(table, 'invoice_id', 'invoices')
      tenantForeignKey(table, 'sales_order_line_id', 'sales_lines')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.unique(['tenant_id', 'invoice_id', 'position'], { indexName: 'invoice_lines_position' })
      table.index(['tenant_id', 'sales_order_line_id'], 'invoice_lines_order_line_index')
    })
    this.schema.raw(`
      ALTER TABLE invoice_lines
        ADD CONSTRAINT invoice_lines_quantity_check CHECK (quantity > 0),
        ADD CONSTRAINT invoice_lines_price_check CHECK (unit_price >= 0 AND discount_amount >= 0),
        ADD CONSTRAINT invoice_lines_tax_check CHECK (tax_rate >= 0),
        ADD CONSTRAINT invoice_lines_exempt_check CHECK (tax_rate > 0 OR exemption_reason IS NOT NULL),
        ADD CONSTRAINT invoice_lines_amounts_check
          CHECK (net_amount >= 0 AND tax_amount >= 0 AND total = net_amount + tax_amount)
    `)
    this.schema.raw(`
      CREATE FUNCTION invoice_lines_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        parent_status text;
        row_ record;
      BEGIN
        IF TG_OP = 'DELETE' THEN row_ := OLD; ELSE row_ := NEW; END IF;
        IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        SELECT status INTO parent_status FROM invoices WHERE tenant_id = row_.tenant_id AND id = row_.invoice_id;
        IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
          RAISE EXCEPTION 'INVOICE_LINES_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
        FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard()
    `)

    createTenantTable(this, 'credit_notes', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('invoice_id').notNullable()
      table.string('number', 60).nullable()
      table.date('issued_on').nullable()
      table.string('reason', 300).notNullable()
      table.decimal('net_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('tax_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('total', 19, 4).notNullable().defaultTo(0)
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.timestamp('issued_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'invoice_id', 'invoices')
      table.index(['tenant_id', 'invoice_id'], 'credit_notes_invoice_index')
    })
    this.schema.raw(`
      ALTER TABLE credit_notes
        ADD CONSTRAINT credit_notes_status_check CHECK (status IN ('DRAFT', 'ISSUED')),
        ADD CONSTRAINT credit_notes_totals_check
          CHECK (net_total >= 0 AND tax_total >= 0 AND total = net_total + tax_total),
        ADD CONSTRAINT credit_notes_issued_check
          CHECK (status = 'DRAFT' OR (number IS NOT NULL AND issued_on IS NOT NULL AND issued_at IS NOT NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX credit_notes_number_unique ON credit_notes (tenant_id, number) WHERE number IS NOT NULL
    `)
    this.schema.raw(`
      CREATE FUNCTION credit_notes_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER credit_notes_guard BEFORE UPDATE OR DELETE ON credit_notes
        FOR EACH ROW EXECUTE FUNCTION credit_notes_guard()
    `)

    createTenantTable(this, 'credit_note_lines', (table) => {
      table.uuid('credit_note_id').notNullable()
      table.uuid('invoice_line_id').notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.decimal('amount', 19, 4).notNullable()
      table.decimal('tax_amount', 19, 4).notNullable().defaultTo(0)
      tenantForeignKey(table, 'credit_note_id', 'credit_notes')
      tenantForeignKey(table, 'invoice_line_id', 'invoice_lines')
      table.unique(['tenant_id', 'credit_note_id', 'invoice_line_id'], {
        indexName: 'credit_note_lines_unique',
      })
      table.index(['tenant_id', 'invoice_line_id'], 'credit_note_lines_invoice_line_index')
    })
    this.schema.raw(`
      ALTER TABLE credit_note_lines
        ADD CONSTRAINT credit_note_lines_quantity_check CHECK (quantity > 0),
        ADD CONSTRAINT credit_note_lines_amount_check CHECK (amount > 0 AND tax_amount >= 0)
    `)
    this.schema.raw(`
      CREATE FUNCTION credit_note_lines_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        parent_status text;
        row_ record;
      BEGIN
        IF TG_OP = 'DELETE' THEN row_ := OLD; ELSE row_ := NEW; END IF;
        IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        SELECT status INTO parent_status FROM credit_notes WHERE tenant_id = row_.tenant_id AND id = row_.credit_note_id;
        IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
          RAISE EXCEPTION 'CREDIT_NOTE_LINES_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER credit_note_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON credit_note_lines
        FOR EACH ROW EXECUTE FUNCTION credit_note_lines_guard()
    `)

    for (const table of [
      'contracts',
      'invoices',
      'invoice_lines',
      'credit_notes',
      'credit_note_lines',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    dropTable(this, 'credit_note_lines')
    dropTable(this, 'credit_notes')
    dropTable(this, 'invoice_lines')
    dropTable(this, 'invoices')
    dropTable(this, 'contracts')
    for (const fn of [
      'credit_note_lines_guard',
      'credit_notes_guard',
      'invoice_lines_guard',
      'invoices_guard',
      'contracts_guard',
    ]) {
      this.schema.raw(`DROP FUNCTION IF EXISTS ${fn}()`)
    }
  }
}
