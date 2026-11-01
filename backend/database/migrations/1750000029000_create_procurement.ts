import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Compras (M06). Fornecedores (condições sobre a Party, tal como os clientes), requisições (pedido interno aprovado por
 * outra pessoa), encomendas a fornecedor e recepções de mercadoria. A encomenda e a recepção seguem o mesmo desenho das
 * vendas: a encomenda confirmada fixa linhas e custos; a recepção é **lançada** (número, entrada de stock) e só se desfaz
 * por **reversão**; o que foi recebido de uma linha é sempre a soma das recepções lançadas e não revertidas (nunca um campo).
 * Documentos confirmados, aprovados ou lançados não se alteram nem se apagam (nem por SQL directo).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'suppliers', (table) => {
      table.uuid('party_id').notNullable()
      table.uuid('organization_id').notNullable()
      table.string('code', 50).notNullable()
      table.integer('payment_term_days').notNullable().defaultTo(0)
      table.string('currency', 3).notNullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.string('status_reason', 300).nullable()
      tenantForeignKey(table, 'party_id', 'parties')
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.unique(['tenant_id', 'code'], { indexName: 'suppliers_code_unique' })
      table.unique(['tenant_id', 'organization_id', 'party_id'], {
        indexName: 'suppliers_party_unique',
      })
      table.index(['tenant_id', 'status'], 'suppliers_status_index')
    })
    this.schema.raw(`
      ALTER TABLE suppliers
        ADD CONSTRAINT suppliers_status_check CHECK (status IN ('ACTIVE', 'BLOCKED', 'INACTIVE')),
        ADD CONSTRAINT suppliers_terms_check CHECK (payment_term_days BETWEEN 0 AND 3650),
        ADD CONSTRAINT suppliers_currency_check CHECK (currency ~ '^[A-Z]{3}$')
    `)

    // --- requisições -----------------------------------------------------------------------------
    createTenantTable(this, 'purchase_requisitions', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('requested_by_membership_id').notNullable()
      table.string('number', 60).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.date('needed_on').nullable()
      table.string('notes', 1000).nullable()
      table.uuid('decided_by_membership_id').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.string('decision_reason', 300).nullable()
      table.uuid('purchase_order_id').nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'requested_by_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'decided_by_membership_id', 'tenant_memberships')
      table.index(['tenant_id', 'status'], 'purchase_requisitions_status_index')
    })
    this.schema.raw(`
      ALTER TABLE purchase_requisitions
        ADD CONSTRAINT purchase_requisitions_status_check
          CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED')),
        ADD CONSTRAINT purchase_requisitions_number_check CHECK (status = 'DRAFT' OR number IS NOT NULL),
        ADD CONSTRAINT purchase_requisitions_decision_check
          CHECK ((status IN ('APPROVED', 'REJECTED', 'CONVERTED')) = (decided_at IS NOT NULL AND decided_by_membership_id IS NOT NULL)),
        ADD CONSTRAINT purchase_requisitions_segregation_check
          CHECK (decided_by_membership_id IS NULL OR decided_by_membership_id <> requested_by_membership_id)
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX purchase_requisitions_number_unique
        ON purchase_requisitions (tenant_id, number) WHERE number IS NOT NULL
    `)

    createTenantTable(this, 'requisition_lines', (table) => {
      table.uuid('requisition_id').notNullable()
      table.integer('position').notNullable()
      table.uuid('variant_id').notNullable()
      table.string('description', 500).notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      tenantForeignKey(table, 'requisition_id', 'purchase_requisitions')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.unique(['tenant_id', 'requisition_id', 'position'], {
        indexName: 'requisition_lines_position_unique',
      })
      table.unique(['tenant_id', 'requisition_id', 'variant_id'], {
        indexName: 'requisition_lines_variant_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE requisition_lines ADD CONSTRAINT requisition_lines_quantity_check CHECK (quantity > 0)
    `)

    // --- encomendas a fornecedor -----------------------------------------------------------------
    createTenantTable(this, 'purchase_orders', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.uuid('requisition_id').nullable()
      table.string('number', 60).nullable()
      table.date('order_date').notNullable()
      table.string('currency', 3).notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('notes', 1000).nullable()
      table.decimal('net_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('tax_total', 19, 4).notNullable().defaultTo(0)
      table.decimal('total', 19, 4).notNullable().defaultTo(0)
      table.timestamp('ordered_at', { useTz: true }).nullable()
      table.timestamp('cancelled_at', { useTz: true }).nullable()
      table.string('cancel_reason', 300).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'requisition_id', 'purchase_requisitions')
      table.index(['tenant_id', 'status'], 'purchase_orders_status_index')
      table.index(['tenant_id', 'supplier_id'], 'purchase_orders_supplier_index')
    })
    this.schema.raw(`
      ALTER TABLE purchase_orders
        ADD CONSTRAINT purchase_orders_status_check
          CHECK (status IN ('DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED')),
        ADD CONSTRAINT purchase_orders_number_check CHECK (status = 'DRAFT' OR number IS NOT NULL),
        ADD CONSTRAINT purchase_orders_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT purchase_orders_totals_check CHECK (total = net_total + tax_total),
        ADD CONSTRAINT purchase_orders_cancel_check
          CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX purchase_orders_number_unique
        ON purchase_orders (tenant_id, number) WHERE number IS NOT NULL
    `)
    // Uma requisição converte-se numa só encomenda.
    this.schema.raw(`
      CREATE UNIQUE INDEX purchase_orders_requisition_unique
        ON purchase_orders (tenant_id, requisition_id) WHERE requisition_id IS NOT NULL
    `)

    createTenantTable(this, 'purchase_lines', (table) => {
      table.uuid('order_id').notNullable()
      table.integer('position').notNullable()
      table.uuid('variant_id').notNullable()
      table.string('description', 500).notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.decimal('unit_cost', 19, 4).notNullable()
      table.decimal('tax_rate', 7, 4).notNullable().defaultTo(0)
      table.decimal('net_amount', 19, 4).notNullable()
      table.decimal('tax_amount', 19, 4).notNullable()
      table.decimal('total', 19, 4).notNullable()
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.unique(['tenant_id', 'order_id', 'position'], {
        indexName: 'purchase_lines_position_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE purchase_lines
        ADD CONSTRAINT purchase_lines_quantity_check CHECK (quantity > 0),
        ADD CONSTRAINT purchase_lines_cost_check CHECK (unit_cost >= 0),
        ADD CONSTRAINT purchase_lines_rate_check CHECK (tax_rate >= 0 AND tax_rate <= 100),
        ADD CONSTRAINT purchase_lines_total_check CHECK (total = net_amount + tax_amount)
    `)

    // --- recepções -------------------------------------------------------------------------------
    createTenantTable(this, 'goods_receipts', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('purchase_order_id').notNullable()
      table.uuid('warehouse_id').nullable()
      table.string('number', 60).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('supplier_document', 100).nullable()
      table.string('notes', 1000).nullable()
      table.timestamp('received_at', { useTz: true }).nullable()
      table.timestamp('reversed_at', { useTz: true }).nullable()
      table.string('reverse_reason', 300).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'purchase_order_id', 'purchase_orders')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      table.index(['tenant_id', 'purchase_order_id'], 'goods_receipts_order_index')
      table.index(['tenant_id', 'status'], 'goods_receipts_status_index')
    })
    this.schema.raw(`
      ALTER TABLE goods_receipts
        ADD CONSTRAINT goods_receipts_status_check CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
        ADD CONSTRAINT goods_receipts_number_check CHECK (status = 'DRAFT' OR number IS NOT NULL),
        ADD CONSTRAINT goods_receipts_posted_check CHECK (status = 'DRAFT' OR received_at IS NOT NULL),
        ADD CONSTRAINT goods_receipts_reversed_check
          CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reverse_reason IS NOT NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX goods_receipts_number_unique
        ON goods_receipts (tenant_id, number) WHERE number IS NOT NULL
    `)

    createTenantTable(this, 'goods_receipt_lines', (table) => {
      table.uuid('receipt_id').notNullable()
      table.uuid('purchase_line_id').notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.string('lot_code', 60).nullable()
      table.date('expires_on').nullable()
      tenantForeignKey(table, 'receipt_id', 'goods_receipts')
      tenantForeignKey(table, 'purchase_line_id', 'purchase_lines')
      table.unique(['tenant_id', 'receipt_id', 'purchase_line_id'], {
        indexName: 'goods_receipt_lines_unique',
      })
      table.index(['tenant_id', 'purchase_line_id'], 'goods_receipt_lines_purchase_line_index')
    })
    this.schema.raw(`
      ALTER TABLE goods_receipt_lines ADD CONSTRAINT goods_receipt_lines_quantity_check CHECK (quantity > 0)
    `)

    // --- imutabilidade ---------------------------------------------------------------------------
    // Cada guarda deixa o rascunho livre; depois só permite as transições do ciclo de vida (o resto fica como estava).
    this.schema.raw(`
      CREATE FUNCTION purchase_requisitions_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'REQUISITION_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
        IF (NEW.tenant_id, NEW.organization_id, NEW.requested_by_membership_id, NEW.number)
             IS NOT DISTINCT FROM (OLD.tenant_id, OLD.organization_id, OLD.requested_by_membership_id, OLD.number)
           AND ((OLD.status = 'SUBMITTED' AND NEW.status IN ('SUBMITTED', 'APPROVED', 'REJECTED'))
             OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPROVED', 'CONVERTED')
                 AND (NEW.decided_by_membership_id, NEW.decided_at) IS NOT DISTINCT FROM (OLD.decided_by_membership_id, OLD.decided_at))) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'REQUISITION_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER purchase_requisitions_guard BEFORE UPDATE OR DELETE ON purchase_requisitions
        FOR EACH ROW EXECUTE FUNCTION purchase_requisitions_guard()
    `)

    this.schema.raw(`
      CREATE FUNCTION purchase_orders_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'PURCHASE_ORDER_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
        IF OLD.status = 'CANCELLED' THEN
          RAISE EXCEPTION 'PURCHASE_ORDER_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        -- Encomendada ou recebida: só mudam o estado (recepções, reversões, cancelamento) e os campos do cancelamento.
        IF (NEW.tenant_id, NEW.organization_id, NEW.supplier_id, NEW.requisition_id, NEW.number, NEW.order_date,
            NEW.currency, NEW.notes, NEW.net_total, NEW.tax_total, NEW.total, NEW.ordered_at)
           IS NOT DISTINCT FROM
           (OLD.tenant_id, OLD.organization_id, OLD.supplier_id, OLD.requisition_id, OLD.number, OLD.order_date,
            OLD.currency, OLD.notes, OLD.net_total, OLD.tax_total, OLD.total, OLD.ordered_at) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'PURCHASE_ORDER_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER purchase_orders_guard BEFORE UPDATE OR DELETE ON purchase_orders
        FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard()
    `)

    this.schema.raw(`
      CREATE FUNCTION goods_receipts_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'GOODS_RECEIPT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
        IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
           AND (NEW.tenant_id, NEW.organization_id, NEW.purchase_order_id, NEW.warehouse_id, NEW.number,
                NEW.received_at, NEW.supplier_document, NEW.notes)
               IS NOT DISTINCT FROM
               (OLD.tenant_id, OLD.organization_id, OLD.purchase_order_id, OLD.warehouse_id, OLD.number,
                OLD.received_at, OLD.supplier_document, OLD.notes) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'GOODS_RECEIPT_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER goods_receipts_guard BEFORE UPDATE OR DELETE ON goods_receipts
        FOR EACH ROW EXECUTE FUNCTION goods_receipts_guard()
    `)

    // As linhas seguem o pai: só se mexe nelas enquanto o pai é rascunho.
    for (const [table, parent, column, error] of [
      [
        'requisition_lines',
        'purchase_requisitions',
        'requisition_id',
        'REQUISITION_LINES_IMMUTABLE',
      ],
      ['purchase_lines', 'purchase_orders', 'order_id', 'PURCHASE_LINES_IMMUTABLE'],
      ['goods_receipt_lines', 'goods_receipts', 'receipt_id', 'GOODS_RECEIPT_LINES_IMMUTABLE'],
    ] as const) {
      this.schema.raw(`
        CREATE FUNCTION ${table}_guard() RETURNS trigger
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
          SELECT status INTO parent_status FROM ${parent} WHERE tenant_id = row_.tenant_id AND id = row_.${column};
          IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
            RAISE EXCEPTION '${error}' USING ERRCODE = '23000';
          END IF;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END
        $$
      `)
      this.schema.raw(`
        CREATE TRIGGER ${table}_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ${table}_guard()
      `)
    }

    for (const table of [
      'suppliers',
      'purchase_requisitions',
      'requisition_lines',
      'purchase_orders',
      'purchase_lines',
      'goods_receipts',
      'goods_receipt_lines',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    for (const table of [
      'goods_receipt_lines',
      'goods_receipts',
      'purchase_lines',
      'purchase_orders',
      'requisition_lines',
      'purchase_requisitions',
      'suppliers',
    ]) {
      dropTable(this, table)
    }
    for (const fn of [
      'goods_receipt_lines_guard',
      'purchase_lines_guard',
      'requisition_lines_guard',
      'goods_receipts_guard',
      'purchase_orders_guard',
      'purchase_requisitions_guard',
    ]) {
      this.schema.raw(`DROP FUNCTION IF EXISTS ${fn}()`)
    }
  }
}
