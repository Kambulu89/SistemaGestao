import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Tesouraria, contas a receber e a pagar (M09). O dinheiro vive em três coisas distintas que nunca se confundem:
 * a **obrigação** (recebível/pagável, nascida de um documento), o **pagamento** (a vontade de liquidar, com alocações) e o
 * **movimento de tesouraria** (o dinheiro que entrou ou saiu da conta). O saldo de uma obrigação nunca é um campo:
 * deriva do original, dos créditos aplicados e das alocações confirmadas e não revertidas. Movimentos, créditos
 * aplicados e pagamentos confirmados não se alteram nem se apagam (nem por SQL directo): reverte-se por operação própria.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'treasury_accounts', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.string('type', 10).notNullable()
      table.string('currency', 3).notNullable()
      table.string('bank_name', 160).nullable()
      table.string('account_identifier', 100).nullable()
      table.boolean('active').notNullable().defaultTo(true)
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.unique(['tenant_id', 'organization_id', 'code'], {
        indexName: 'treasury_accounts_code_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE treasury_accounts
        ADD CONSTRAINT treasury_accounts_type_check CHECK (type IN ('CASH', 'BANK')),
        ADD CONSTRAINT treasury_accounts_currency_check CHECK (currency ~ '^[A-Z]{3}$')
    `)

    // --- obrigações ------------------------------------------------------------------------------
    for (const name of ['receivables', 'payables']) {
      createTenantTable(this, name, (table) => {
        table.uuid('organization_id').notNullable()
        table.uuid('party_id').notNullable()
        table.string('source_type', 40).notNullable()
        table.uuid('source_id').notNullable()
        table.integer('installment_no').notNullable().defaultTo(1)
        table.decimal('original_amount', 19, 4).notNullable()
        table.string('currency', 3).notNullable()
        table.date('due_on').notNullable()
        table.string('status', 10).notNullable().defaultTo('OPEN')
        table.timestamp('closed_at', { useTz: true }).nullable()
        tenantForeignKey(table, 'organization_id', 'organizations')
        tenantForeignKey(table, 'party_id', 'parties')
        table.unique(['tenant_id', 'source_type', 'source_id', 'installment_no'], {
          indexName: `${name}_source_unique`,
        })
        table.index(['tenant_id', 'party_id', 'status'], `${name}_party_index`)
        table.index(['tenant_id', 'due_on'], `${name}_due_index`)
      })
      this.schema.raw(`
        ALTER TABLE ${name}
          ADD CONSTRAINT ${name}_amount_check CHECK (original_amount > 0),
          ADD CONSTRAINT ${name}_status_check CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
          ADD CONSTRAINT ${name}_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
          ADD CONSTRAINT ${name}_installment_check CHECK (installment_no >= 1)
      `)
      // O que identifica a obrigação não muda; só o estado (e quando fechou).
      this.schema.raw(`
        CREATE FUNCTION ${name}_guard() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION 'OBLIGATION_IMMUTABLE' USING ERRCODE = '23000';
          END IF;
          IF (NEW.tenant_id, NEW.organization_id, NEW.party_id, NEW.source_type, NEW.source_id, NEW.installment_no,
              NEW.original_amount, NEW.currency, NEW.due_on)
             IS DISTINCT FROM
             (OLD.tenant_id, OLD.organization_id, OLD.party_id, OLD.source_type, OLD.source_id, OLD.installment_no,
              OLD.original_amount, OLD.currency, OLD.due_on) THEN
            RAISE EXCEPTION 'OBLIGATION_IMMUTABLE' USING ERRCODE = '23000';
          END IF;
          RETURN NEW;
        END
        $$
      `)
      this.schema.raw(`
        CREATE TRIGGER ${name}_guard BEFORE UPDATE OR DELETE ON ${name}
          FOR EACH ROW EXECUTE FUNCTION ${name}_guard()
      `)
    }

    // Créditos (notas de crédito) aplicados a um recebível: só se acrescentam.
    createTenantTable(this, 'credit_applications', (table) => {
      table.uuid('receivable_id').notNullable()
      table.string('source_type', 40).notNullable()
      table.uuid('source_id').notNullable()
      table.decimal('amount', 19, 4).notNullable()
      tenantForeignKey(table, 'receivable_id', 'receivables')
      table.unique(['tenant_id', 'source_type', 'source_id'], {
        indexName: 'credit_applications_source_unique',
      })
      table.index(['tenant_id', 'receivable_id'], 'credit_applications_receivable_index')
    })
    this.schema.raw(`
      ALTER TABLE credit_applications ADD CONSTRAINT credit_applications_amount_check CHECK (amount > 0)
    `)

    // --- facturas de fornecedor ------------------------------------------------------------------
    createTenantTable(this, 'supplier_invoices', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.string('external_number', 80).notNullable()
      table.uuid('purchase_order_id').nullable()
      table.date('invoice_date').notNullable()
      table.date('due_on').notNullable()
      table.string('currency', 3).notNullable()
      table.decimal('net_amount', 19, 4).notNullable().defaultTo(0)
      table.decimal('tax_amount', 19, 4).notNullable().defaultTo(0)
      table.decimal('total', 19, 4).notNullable().defaultTo(0)
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.jsonb('matching').nullable()
      table.string('override_reason', 300).nullable()
      table.timestamp('validated_at', { useTz: true }).nullable()
      table.string('notes', 1000).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'purchase_order_id', 'purchase_orders')
      table.unique(['tenant_id', 'supplier_id', 'external_number'], {
        indexName: 'supplier_invoices_external_unique',
      })
      table.index(['tenant_id', 'status'], 'supplier_invoices_status_index')
    })
    this.schema.raw(`
      ALTER TABLE supplier_invoices
        ADD CONSTRAINT supplier_invoices_status_check CHECK (status IN ('DRAFT', 'VALIDATED', 'DISPUTED', 'VOID')),
        ADD CONSTRAINT supplier_invoices_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT supplier_invoices_totals_check CHECK (total = net_amount + tax_amount),
        ADD CONSTRAINT supplier_invoices_due_check CHECK (due_on >= invoice_date),
        ADD CONSTRAINT supplier_invoices_validated_check CHECK ((status = 'VALIDATED') = (validated_at IS NOT NULL))
    `)
    createTenantTable(this, 'supplier_invoice_lines', (table) => {
      table.uuid('supplier_invoice_id').notNullable()
      table.integer('position').notNullable()
      table.uuid('purchase_line_id').nullable()
      table.string('description', 500).notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.decimal('unit_price', 19, 4).notNullable()
      table.decimal('tax_rate', 7, 4).notNullable().defaultTo(0)
      table.decimal('net_amount', 19, 4).notNullable()
      table.decimal('tax_amount', 19, 4).notNullable()
      table.decimal('total', 19, 4).notNullable()
      tenantForeignKey(table, 'supplier_invoice_id', 'supplier_invoices')
      tenantForeignKey(table, 'purchase_line_id', 'purchase_lines')
      table.unique(['tenant_id', 'supplier_invoice_id', 'position'], {
        indexName: 'supplier_invoice_lines_position_unique',
      })
      table.index(['tenant_id', 'purchase_line_id'], 'supplier_invoice_lines_purchase_line_index')
    })
    this.schema.raw(`
      ALTER TABLE supplier_invoice_lines
        ADD CONSTRAINT supplier_invoice_lines_quantity_check CHECK (quantity > 0),
        ADD CONSTRAINT supplier_invoice_lines_price_check CHECK (unit_price >= 0),
        ADD CONSTRAINT supplier_invoice_lines_total_check CHECK (total = net_amount + tax_amount)
    `)

    // --- pagamentos e alocações ------------------------------------------------------------------
    createTenantTable(this, 'payments', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('direction', 10).notNullable()
      table.uuid('party_id').notNullable()
      table.uuid('treasury_account_id').notNullable()
      table.decimal('amount', 19, 4).notNullable()
      table.string('currency', 3).notNullable()
      table.string('method', 10).notNullable()
      table.date('occurred_on').notNullable()
      table.string('reference', 160).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('provider', 40).nullable()
      table.string('provider_reference', 160).nullable()
      table.string('idempotency_key', 100).nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.timestamp('reversed_at', { useTz: true }).nullable()
      table.string('reverse_reason', 300).nullable()
      table.string('failure_reason', 300).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'party_id', 'parties')
      tenantForeignKey(table, 'treasury_account_id', 'treasury_accounts')
      table.index(['tenant_id', 'status'], 'payments_status_index')
      table.index(['tenant_id', 'party_id'], 'payments_party_index')
    })
    this.schema.raw(`
      ALTER TABLE payments
        ADD CONSTRAINT payments_direction_check CHECK (direction IN ('INBOUND', 'OUTBOUND')),
        ADD CONSTRAINT payments_amount_check CHECK (amount > 0),
        ADD CONSTRAINT payments_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT payments_method_check CHECK (method IN ('CASH', 'TRANSFER', 'CARD', 'OTHER')),
        ADD CONSTRAINT payments_status_check
          CHECK (status IN ('DRAFT', 'PENDING', 'CONFIRMED', 'FAILED', 'REVERSED')),
        ADD CONSTRAINT payments_confirmed_check
          CHECK ((status IN ('CONFIRMED', 'REVERSED')) = (confirmed_at IS NOT NULL)),
        ADD CONSTRAINT payments_reversed_check
          CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reverse_reason IS NOT NULL)),
        ADD CONSTRAINT payments_failed_check CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL)),
        ADD CONSTRAINT payments_provider_check CHECK ((provider IS NULL) = (provider_reference IS NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX payments_provider_unique
        ON payments (tenant_id, provider, provider_reference) WHERE provider_reference IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX payments_idempotency_unique
        ON payments (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    `)

    createTenantTable(this, 'payment_allocations', (table) => {
      table.uuid('payment_id').notNullable()
      table.uuid('receivable_id').nullable()
      table.uuid('payable_id').nullable()
      table.decimal('amount', 19, 4).notNullable()
      table.string('target_currency', 3).notNullable()
      table.decimal('exchange_rate', 19, 6).notNullable().defaultTo(1)
      table.decimal('target_amount', 19, 4).notNullable()
      table.timestamp('reversed_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'payment_id', 'payments')
      tenantForeignKey(table, 'receivable_id', 'receivables')
      tenantForeignKey(table, 'payable_id', 'payables')
      table.index(['tenant_id', 'payment_id'], 'payment_allocations_payment_index')
      table.index(['tenant_id', 'receivable_id'], 'payment_allocations_receivable_index')
      table.index(['tenant_id', 'payable_id'], 'payment_allocations_payable_index')
    })
    this.schema.raw(`
      ALTER TABLE payment_allocations
        ADD CONSTRAINT payment_allocations_target_check
          CHECK ((receivable_id IS NULL) <> (payable_id IS NULL)),
        ADD CONSTRAINT payment_allocations_amount_check CHECK (amount > 0 AND target_amount > 0),
        ADD CONSTRAINT payment_allocations_rate_check CHECK (exchange_rate > 0),
        ADD CONSTRAINT payment_allocations_currency_check CHECK (target_currency ~ '^[A-Z]{3}$')
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX payment_allocations_receivable_unique
        ON payment_allocations (tenant_id, payment_id, receivable_id) WHERE receivable_id IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX payment_allocations_payable_unique
        ON payment_allocations (tenant_id, payment_id, payable_id) WHERE payable_id IS NOT NULL
    `)

    createTenantTable(this, 'treasury_entries', (table) => {
      table.uuid('account_id').notNullable()
      table.uuid('payment_id').nullable()
      table.decimal('amount_signed', 19, 4).notNullable()
      table.date('occurred_on').notNullable()
      table.uuid('reversal_of_id').nullable()
      table.string('source_key', 160).notNullable()
      tenantForeignKey(table, 'account_id', 'treasury_accounts')
      tenantForeignKey(table, 'payment_id', 'payments')
      table.unique(['tenant_id', 'source_key'], { indexName: 'treasury_entries_source_unique' })
      table.index(['tenant_id', 'account_id', 'occurred_on'], 'treasury_entries_account_index')
    })
    this.schema.raw(
      `ALTER TABLE treasury_entries ADD CONSTRAINT treasury_entries_amount_check CHECK (amount_signed <> 0)`
    )
    // A reversão aponta para o movimento original do mesmo tenant (FK composta).
    this.schema.raw(`
      ALTER TABLE treasury_entries
        ADD CONSTRAINT treasury_entries_reversal_fk FOREIGN KEY (tenant_id, reversal_of_id)
          REFERENCES treasury_entries (tenant_id, id)
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX treasury_entries_reversal_unique
        ON treasury_entries (tenant_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL
    `)

    // --- reservas de crédito ---------------------------------------------------------------------
    // A exposição de crédito de um cliente = recebíveis em aberto + reservas activas (encomendas confirmadas por facturar).
    createTenantTable(this, 'credit_reservations', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.uuid('order_id').notNullable()
      table.string('currency', 3).notNullable()
      table.decimal('amount', 19, 4).notNullable()
      table.decimal('remaining', 19, 4).notNullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'order_id', 'sales_orders')
      table.unique(['tenant_id', 'order_id'], { indexName: 'credit_reservations_order_unique' })
      table.index(['tenant_id', 'customer_id', 'status'], 'credit_reservations_customer_index')
    })
    this.schema.raw(`
      ALTER TABLE credit_reservations
        ADD CONSTRAINT credit_reservations_status_check CHECK (status IN ('ACTIVE', 'RELEASED')),
        ADD CONSTRAINT credit_reservations_amount_check CHECK (amount >= 0 AND remaining >= 0 AND remaining <= amount),
        ADD CONSTRAINT credit_reservations_currency_check CHECK (currency ~ '^[A-Z]{3}$')
    `)

    // --- imutabilidade ---------------------------------------------------------------------------
    this.schema.raw(`
      CREATE FUNCTION finance_append_only() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'FINANCE_APPEND_ONLY' USING ERRCODE = '23000';
      END
      $$
    `)
    for (const table of ['treasury_entries', 'credit_applications']) {
      this.schema.raw(`
        CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION finance_append_only()
      `)
    }

    // Pagamento: livre em rascunho/pendente; confirmado só passa a revertido; falhado e revertido são finais.
    this.schema.raw(`
      CREATE FUNCTION payments_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'PAYMENT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('DRAFT', 'PENDING') THEN RETURN NEW; END IF;
        IF OLD.status = 'CONFIRMED' AND NEW.status IN ('CONFIRMED', 'REVERSED')
           AND (NEW.tenant_id, NEW.organization_id, NEW.direction, NEW.party_id, NEW.treasury_account_id, NEW.amount,
                NEW.currency, NEW.method, NEW.occurred_on, NEW.reference, NEW.provider, NEW.provider_reference,
                NEW.idempotency_key, NEW.confirmed_at)
              IS NOT DISTINCT FROM
              (OLD.tenant_id, OLD.organization_id, OLD.direction, OLD.party_id, OLD.treasury_account_id, OLD.amount,
               OLD.currency, OLD.method, OLD.occurred_on, OLD.reference, OLD.provider, OLD.provider_reference,
               OLD.idempotency_key, OLD.confirmed_at) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'PAYMENT_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
        FOR EACH ROW EXECUTE FUNCTION payments_guard()
    `)
    // Alocações: livres enquanto o pagamento não está confirmado; depois só se marcam como revertidas.
    this.schema.raw(`
      CREATE FUNCTION payment_allocations_guard() RETURNS trigger
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
        SELECT status INTO parent_status FROM payments WHERE tenant_id = row_.tenant_id AND id = row_.payment_id;
        IF parent_status IS NULL OR parent_status IN ('DRAFT', 'PENDING') THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' AND parent_status = 'CONFIRMED' AND OLD.reversed_at IS NULL
           AND (NEW.tenant_id, NEW.payment_id, NEW.receivable_id, NEW.payable_id, NEW.amount, NEW.target_currency,
                NEW.exchange_rate, NEW.target_amount)
              IS NOT DISTINCT FROM
              (OLD.tenant_id, OLD.payment_id, OLD.receivable_id, OLD.payable_id, OLD.amount, OLD.target_currency,
               OLD.exchange_rate, OLD.target_amount) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'PAYMENT_ALLOCATIONS_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER payment_allocations_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_allocations
        FOR EACH ROW EXECUTE FUNCTION payment_allocations_guard()
    `)
    // Factura de fornecedor: livre em rascunho; validada é final; em disputa volta a rascunho, valida-se ou anula-se.
    this.schema.raw(`
      CREATE FUNCTION supplier_invoices_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'SUPPLIER_INVOICE_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('VALIDATED', 'VOID') THEN
          RAISE EXCEPTION 'SUPPLIER_INVOICE_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER supplier_invoices_guard BEFORE UPDATE OR DELETE ON supplier_invoices
        FOR EACH ROW EXECUTE FUNCTION supplier_invoices_guard()
    `)
    this.schema.raw(`
      CREATE FUNCTION supplier_invoice_lines_guard() RETURNS trigger
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
        SELECT status INTO parent_status FROM supplier_invoices
          WHERE tenant_id = row_.tenant_id AND id = row_.supplier_invoice_id;
        IF parent_status IS NOT NULL AND parent_status NOT IN ('DRAFT') THEN
          RAISE EXCEPTION 'SUPPLIER_INVOICE_LINES_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER supplier_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_invoice_lines
        FOR EACH ROW EXECUTE FUNCTION supplier_invoice_lines_guard()
    `)

    auditTable(this, 'treasury_accounts', ['account_identifier'])
    for (const table of [
      'receivables',
      'payables',
      'credit_applications',
      'supplier_invoices',
      'supplier_invoice_lines',
      'payments',
      'payment_allocations',
      'treasury_entries',
      'credit_reservations',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    for (const table of [
      'credit_reservations',
      'treasury_entries',
      'payment_allocations',
      'payments',
      'supplier_invoice_lines',
      'supplier_invoices',
      'credit_applications',
      'payables',
      'receivables',
      'treasury_accounts',
    ]) {
      dropTable(this, table)
    }
    for (const fn of [
      'supplier_invoice_lines_guard',
      'supplier_invoices_guard',
      'payment_allocations_guard',
      'payments_guard',
      'finance_append_only',
      'payables_guard',
      'receivables_guard',
    ]) {
      this.schema.raw(`DROP FUNCTION IF EXISTS ${fn}()`)
    }
  }
}
