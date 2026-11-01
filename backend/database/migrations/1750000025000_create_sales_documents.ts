import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Propostas e encomendas (M04). O documento guarda o **instantâneo** do que foi acordado: descrição, quantidade, preço,
 * desconto e taxa de imposto de cada linha, com o resultado arredondado — alterar o catálogo ou as tabelas de preços
 * depois não mexe em linhas já criadas. As linhas só se alteram enquanto o documento é rascunho (nem SQL directo o
 * contorna). Confirmar uma encomenda não reserva stock nem expede: são operações próprias, de fatias seguintes.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'sales_quotes', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.string('number', 60).nullable()
      table.date('valid_until').notNullable()
      table.string('currency', 3).notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('notes', 1000).nullable()
      table.decimal('net_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('tax_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('total', 19, 4).notNullable().defaultTo(0)
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'customer_id', 'customers')
      table.index(['tenant_id', 'customer_id'], 'sales_quotes_customer_index')
      table.index(['tenant_id', 'status'], 'sales_quotes_status_index')
    })
    this.schema.raw(`
      ALTER TABLE sales_quotes
        ADD CONSTRAINT sales_quotes_status_check CHECK (status IN ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED')),
        ADD CONSTRAINT sales_quotes_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT sales_quotes_totals_check CHECK (net_total >= 0 AND tax_total >= 0 AND total = net_total + tax_total),
        ADD CONSTRAINT sales_quotes_number_check CHECK (status = 'DRAFT' OR number IS NOT NULL)
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX sales_quotes_number_unique ON sales_quotes (tenant_id, number) WHERE number IS NOT NULL
    `)

    createTenantTable(this, 'sales_orders', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.uuid('quote_id').nullable()
      table.string('number', 60).nullable()
      table.date('order_date').notNullable()
      table.string('currency', 3).notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.jsonb('delivery_address_snapshot').nullable()
      table.decimal('credit_reservation', 19, 4).notNullable().defaultTo(0)
      table.decimal('net_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('tax_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('total', 19, 4).notNullable().defaultTo(0)
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.timestamp('cancelled_at', { useTz: true }).nullable()
      table.string('cancel_reason', 300).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'quote_id', 'sales_quotes')
      table.index(['tenant_id', 'customer_id'], 'sales_orders_customer_index')
      table.index(['tenant_id', 'status'], 'sales_orders_status_index')
    })
    this.schema.raw(`
      ALTER TABLE sales_orders
        ADD CONSTRAINT sales_orders_status_check
          CHECK (status IN ('DRAFT', 'CONFIRMED', 'PARTIAL', 'FULFILLED', 'CANCELLED')),
        ADD CONSTRAINT sales_orders_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT sales_orders_totals_check CHECK (net_total >= 0 AND tax_total >= 0 AND total = net_total + tax_total),
        ADD CONSTRAINT sales_orders_credit_check CHECK (credit_reservation >= 0),
        ADD CONSTRAINT sales_orders_number_check CHECK (status IN ('DRAFT', 'CANCELLED') OR number IS NOT NULL),
        ADD CONSTRAINT sales_orders_cancel_check
          CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
        ADD CONSTRAINT sales_orders_confirm_check
          CHECK (status = 'DRAFT' OR status = 'CANCELLED' OR confirmed_at IS NOT NULL)
    `)
    // Uma proposta converte-se numa só encomenda: aceitar duas vezes devolve a mesma (comando idempotente).
    this.schema.raw(`
      CREATE UNIQUE INDEX sales_orders_quote_unique ON sales_orders (tenant_id, quote_id) WHERE quote_id IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX sales_orders_number_unique ON sales_orders (tenant_id, number) WHERE number IS NOT NULL
    `)

    createTenantTable(this, 'sales_lines', (table) => {
      table.uuid('quote_id').nullable()
      table.uuid('order_id').nullable()
      table.integer('position').notNullable()
      table.uuid('variant_id').notNullable()
      table.string('description_snapshot', 500).notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.uuid('unit_id').notNullable()
      table.decimal('unit_price', 19, 4).notNullable()
      table.decimal('discount_rate', 5, 4).notNullable().defaultTo(0)
      table.decimal('tax_rate_snapshot', 9, 4).notNullable().defaultTo(0)
      table.boolean('tax_inclusive').notNullable().defaultTo(false)
      table.decimal('net_amount', 19, 4).notNullable()
      table.decimal('tax_amount', 19, 4).notNullable()
      table.decimal('total', 19, 4).notNullable()
      table.jsonb('price_origin').notNullable()
      tenantForeignKey(table, 'quote_id', 'sales_quotes')
      tenantForeignKey(table, 'order_id', 'sales_orders')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'unit_id', 'units_of_measure')
      table.index(['tenant_id', 'quote_id', 'position'], 'sales_lines_quote_index')
      table.index(['tenant_id', 'order_id', 'position'], 'sales_lines_order_index')
      table.index(['tenant_id', 'variant_id'], 'sales_lines_variant_index')
    })
    this.schema.raw(`
      ALTER TABLE sales_lines
        ADD CONSTRAINT sales_lines_owner_check CHECK ((quote_id IS NULL) <> (order_id IS NULL)),
        ADD CONSTRAINT sales_lines_quantity_check CHECK (quantity > 0),
        ADD CONSTRAINT sales_lines_price_check CHECK (unit_price >= 0),
        ADD CONSTRAINT sales_lines_discount_check CHECK (discount_rate BETWEEN 0 AND 1),
        ADD CONSTRAINT sales_lines_tax_check CHECK (tax_rate_snapshot >= 0),
        ADD CONSTRAINT sales_lines_amounts_check
          CHECK (net_amount >= 0 AND tax_amount >= 0 AND total = net_amount + tax_amount),
        ADD CONSTRAINT sales_lines_origin_check CHECK (jsonb_typeof(price_origin) = 'object')
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX sales_lines_quote_position ON sales_lines (tenant_id, quote_id, position) WHERE quote_id IS NOT NULL
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX sales_lines_order_position ON sales_lines (tenant_id, order_id, position) WHERE order_id IS NOT NULL
    `)

    // As linhas de um documento que já não é rascunho não se acrescentam, alteram nem removem (nem SQL directo).
    this.schema.raw(`
      CREATE FUNCTION sales_lines_guard() RETURNS trigger
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
        IF row_.quote_id IS NOT NULL THEN
          SELECT status INTO parent_status FROM sales_quotes WHERE tenant_id = row_.tenant_id AND id = row_.quote_id;
        ELSE
          SELECT status INTO parent_status FROM sales_orders WHERE tenant_id = row_.tenant_id AND id = row_.order_id;
        END IF;
        IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
          RAISE EXCEPTION 'SALES_LINES_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER sales_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_lines
        FOR EACH ROW EXECUTE FUNCTION sales_lines_guard()
    `)

    auditTable(this, 'sales_quotes')
    auditTable(this, 'sales_orders')
    auditTable(this, 'sales_lines')
  }

  async down() {
    dropTable(this, 'sales_lines')
    dropTable(this, 'sales_orders')
    dropTable(this, 'sales_quotes')
    this.schema.raw('DROP FUNCTION IF EXISTS sales_lines_guard()')
  }
}
