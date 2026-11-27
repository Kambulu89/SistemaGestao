import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Facturação recorrente (Prompt 10, bloco 10.11) — módulo `sales`.
 *
 *  - `sales_recurring_contracts`: contrato com o cliente (entidade, moeda, periodicidade, início/fim, facturação no
 *    início ou no fim do período, prazo) e estado (rascunho → activo → suspenso/terminado). `periods_generated` é o
 *    índice do próximo período (os períodos calculam-se do início, sem deriva de fim de mês).
 *  - `sales_recurring_versions` (+ linhas): versões de preço/linhas com data de entrada em vigor; aprovadas por outra
 *    pessoa e imutáveis. Uma linha com preço fixa-o (origem CONTRACT na factura); sem preço, usa o motor de preços à
 *    data da factura (tabelas do 10.2, também versionadas).
 *  - `sales_recurring_runs`: um registo por período gerado (ou falhado, com o motivo). Um só período GERADO por
 *    contrato e data (índice único parcial). A geração cria RASCUNHOS de factura: nunca emite.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'sales_recurring_contracts', (table) => {
      table.string('reference', 40).notNullable()
      table.string('description', 300).notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.string('frequency', 12).notNullable()
      table.string('billing_timing', 8).notNullable().defaultTo('ADVANCE')
      table.date('start_date').notNullable()
      table.date('end_date').nullable()
      table.integer('payment_terms_days').notNullable().defaultTo(30)
      table.integer('periods_generated').notNullable().defaultTo(0)
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('status_reason', 500).nullable()
      table.uuid('owner_membership_id').notNullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'customer_id', 'customers')
      table.unique(['tenant_id', 'reference'], {
        indexName: 'sales_recurring_contracts_ref_unique',
      })
      table.index(['tenant_id', 'status'], 'sales_recurring_contracts_status_index')
      table.check(
        `frequency IN ('MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL') AND billing_timing IN ('ADVANCE','ARREARS')
         AND status IN ('DRAFT','ACTIVE','SUSPENDED','ENDED') AND payment_terms_days BETWEEN 0 AND 365
         AND periods_generated >= 0 AND (end_date IS NULL OR end_date >= start_date)
         AND (status NOT IN ('SUSPENDED','ENDED') OR status_reason IS NOT NULL)`,
        [],
        'sales_recurring_contracts_values_check'
      )
    })

    createTenantTable(this, 'sales_recurring_versions', (table) => {
      table.uuid('contract_id').notNullable()
      table.integer('version_no').notNullable()
      table.date('valid_from').notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('notes', 500).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.string('decision_reason', 500).nullable()
      tenantForeignKey(table, 'contract_id', 'sales_recurring_contracts')
      table.unique(['tenant_id', 'contract_id', 'version_no'], {
        indexName: 'sales_recurring_versions_no_unique',
      })
      table.check(
        `status IN ('DRAFT','APPROVED','DISCARDED')
         AND (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
         AND (approved_by IS NULL OR approved_by <> created_by)
         AND (status <> 'DISCARDED' OR decision_reason IS NOT NULL)`,
        [],
        'sales_recurring_versions_values_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX sales_recurring_versions_from_unique
      ON sales_recurring_versions (tenant_id, contract_id, valid_from) WHERE status = 'APPROVED'`)

    createTenantTable(this, 'sales_recurring_version_lines', (table) => {
      table.uuid('version_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').notNullable()
      table.string('description', 300).nullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('unit_price', 20, 4).nullable()
      table.specificType('tax_code_ids', 'uuid[]').notNullable()
      table.string('exemption_code', 20).nullable()
      tenantForeignKey(table, 'version_id', 'sales_recurring_versions')
      tenantForeignKey(table, 'product_id', 'products')
      table.unique(['tenant_id', 'version_id', 'product_id'], {
        indexName: 'sales_recurring_version_lines_product_unique',
      })
      table.check(
        `quantity > 0 AND (unit_price IS NULL OR unit_price >= 0) AND cardinality(tax_code_ids) >= 1`,
        [],
        'sales_recurring_version_lines_values_check'
      )
    })

    createTenantTable(this, 'sales_recurring_runs', (table) => {
      table.uuid('contract_id').notNullable()
      table.integer('period_index').notNullable()
      table.date('period_start').notNullable()
      table.date('period_end').notNullable()
      table.date('invoice_date').notNullable()
      table.uuid('version_id').nullable()
      table.uuid('invoice_id').nullable()
      table.string('status', 10).notNullable()
      table.string('reason', 500).nullable()
      tenantForeignKey(table, 'contract_id', 'sales_recurring_contracts')
      tenantForeignKey(table, 'version_id', 'sales_recurring_versions')
      tenantForeignKey(table, 'invoice_id', 'sales_invoices')
      table.index(['tenant_id', 'contract_id'], 'sales_recurring_runs_contract_index')
      table.check(
        `status IN ('GENERATED','FAILED') AND period_end >= period_start
         AND ((status = 'GENERATED') = (invoice_id IS NOT NULL AND version_id IS NOT NULL))
         AND (status <> 'FAILED' OR reason IS NOT NULL)`,
        [],
        'sales_recurring_runs_values_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX sales_recurring_runs_period_unique
      ON sales_recurring_runs (tenant_id, contract_id, period_index) WHERE status = 'GENERATED'`)

    // Factura gerada de um período: a ligação e a origem de preço do contrato.
    this.schema.raw(`ALTER TABLE sales_invoices ADD COLUMN recurring_version_id uuid NULL`)
    this.schema.raw(`ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_recurring_version_fk
      FOREIGN KEY (tenant_id, recurring_version_id) REFERENCES sales_recurring_versions (tenant_id, id)`)
    this.schema.raw(
      `ALTER TABLE sales_invoice_lines DROP CONSTRAINT sales_invoice_lines_values_check`
    )
    this.schema
      .raw(`ALTER TABLE sales_invoice_lines ADD CONSTRAINT sales_invoice_lines_values_check CHECK (
         quantity > 0 AND net_amount >= 0 AND tax_amount >= 0 AND cardinality(tax_code_ids) >= 1
         AND NOT (manual_discount_pct IS NOT NULL AND manual_unit_price IS NOT NULL)
         AND price_source IN ('LIST','CATALOG','MANUAL','NONE','ORDER','CONTRACT'))`)

    // Imutabilidade: versão aprovada não muda (nem as linhas); descartada é final; períodos só de acréscimo.
    this.schema.raw(`
      CREATE FUNCTION sales_recurring_versions_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'VERSION_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_recurring_versions_fixed BEFORE UPDATE OR DELETE
      ON sales_recurring_versions FOR EACH ROW EXECUTE FUNCTION sales_recurring_versions_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION sales_recurring_version_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM sales_recurring_versions
         WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.version_id, OLD.version_id);
        IF s IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'VERSION_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER sales_recurring_version_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON sales_recurring_version_lines FOR EACH ROW EXECUTE FUNCTION sales_recurring_version_lines_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION sales_recurring_runs_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_recurring_runs_fixed BEFORE UPDATE OR DELETE
      ON sales_recurring_runs FOR EACH ROW EXECUTE FUNCTION sales_recurring_runs_fixed()`)
    // O índice de períodos só avança; terminado é final.
    this.schema.raw(`
      CREATE FUNCTION sales_recurring_contracts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status = 'ENDED' OR NEW.periods_generated < OLD.periods_generated THEN
          RAISE EXCEPTION 'CONTRACT_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'DRAFT' AND (NEW.start_date IS DISTINCT FROM OLD.start_date
            OR NEW.frequency IS DISTINCT FROM OLD.frequency OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
            OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR NEW.currency IS DISTINCT FROM OLD.currency
            OR NEW.billing_timing IS DISTINCT FROM OLD.billing_timing) THEN
          RAISE EXCEPTION 'CONTRACT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_recurring_contracts_fixed BEFORE UPDATE OR DELETE
      ON sales_recurring_contracts FOR EACH ROW EXECUTE FUNCTION sales_recurring_contracts_fixed()`)
  }

  async down() {
    this.schema.raw(
      `ALTER TABLE sales_invoice_lines DROP CONSTRAINT sales_invoice_lines_values_check`
    )
    this.schema
      .raw(`ALTER TABLE sales_invoice_lines ADD CONSTRAINT sales_invoice_lines_values_check CHECK (
         quantity > 0 AND net_amount >= 0 AND tax_amount >= 0 AND cardinality(tax_code_ids) >= 1
         AND NOT (manual_discount_pct IS NOT NULL AND manual_unit_price IS NOT NULL)
         AND price_source IN ('LIST','CATALOG','MANUAL','NONE','ORDER')) NOT VALID`)
    this.schema.raw(
      `ALTER TABLE sales_invoices DROP CONSTRAINT sales_invoices_recurring_version_fk`
    )
    this.schema.raw(`ALTER TABLE sales_invoices DROP COLUMN recurring_version_id`)
    this.schema.dropTable('sales_recurring_runs')
    this.schema.dropTable('sales_recurring_version_lines')
    this.schema.dropTable('sales_recurring_versions')
    this.schema.dropTable('sales_recurring_contracts')
    for (const f of [
      'sales_recurring_contracts_fixed',
      'sales_recurring_runs_fixed',
      'sales_recurring_version_lines_fixed',
      'sales_recurring_versions_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
