import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Ordens de compra (Prompt 09, bloco 9.5).
 *
 *  - `purchase_orders`: fornecedor, entidade legal, filial, centro de custo, armazém de entrega, adjudicação de origem,
 *    moeda e câmbio (fixado ao pedir aprovação), condições de entrega e pagamento, datas, totais e três estados
 *    independentes — aprovação (rascunho → em aprovação → aprovada | recusada; anulada), recepção (preenchida pelo 9.7)
 *    e facturação (pelo 9.8). A emissão dá o número da série `PURCHASE_ORDER` (uma vez, na primeira emissão) e regista a
 *    revisão emitida. Uma revisão de uma ordem emitida volta a rascunho com a revisão seguinte, guarda a versão anterior
 *    e exige nova aprovação e nova emissão (o número mantém-se).
 *  - `purchase_order_lines`: produto ou descrição, quantidade, preço, desconto, imposto e valores exactos; origem
 *    (linha de requisição, linha adjudicada); quantidades recebida, facturada, cancelada (fecho do resto) e afectada à
 *    requisição.
 *  - `purchase_order_approvals`: decisões por ronda de aprovação (cada pedido de aprovação é uma ronda) e etapa (só
 *    acréscimo).
 *  - `purchase_order_revisions`: fotografia de cada versão emitida antes de ser revista (só acréscimo).
 *  - `purchase_order_events`: histórico (só acréscimo).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'purchase_orders', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.uuid('supplier_id').notNullable()
      table.uuid('cost_center_id').nullable()
      table.uuid('warehouse_id').nullable()
      table.uuid('award_id').nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('exchange_rate', 20, 10).nullable()
      table.date('rate_date').nullable()
      table.date('order_date').notNullable()
      table.date('expected_date').nullable()
      table.integer('payment_terms_days').nullable()
      table.string('payment_method', 10).nullable()
      table.string('incoterm', 3).nullable()
      table.string('delivery_terms', 500).nullable()
      table.string('delivery_address', 500).nullable()
      table.string('supplier_reference', 60).nullable()
      table.text('notes').nullable()
      table.decimal('total_gross', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_discount', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_net', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_tax', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_functional', 20, 2).nullable()
      table.integer('revision').notNullable().defaultTo(0)
      table.integer('approval_round').notNullable().defaultTo(0)
      table.string('approval_status', 20).notNullable().defaultTo('DRAFT')
      table.jsonb('required_levels').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('submitted_by').nullable()
      table.uuid('submitted_by_membership_id').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.string('reject_reason', 500).nullable()
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.integer('issued_revision').nullable()
      table.timestamp('issued_at', { useTz: true }).nullable()
      table.uuid('issued_by').nullable()
      table.string('receipt_status', 20).notNullable().defaultTo('NOT_RECEIVED')
      table.string('invoice_status', 20).notNullable().defaultTo('NOT_INVOICED')
      table.timestamp('closed_at', { useTz: true }).nullable()
      table.string('close_reason', 500).nullable()
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'award_id', 'rfq_awards')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'purchase_orders_number_unique',
      })
      table.index(['tenant_id', 'approval_status'], 'purchase_orders_approval_index')
      table.index(['tenant_id', 'supplier_id'], 'purchase_orders_supplier_index')
      table.check(
        `approval_status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED')`,
        [],
        'purchase_orders_approval_check'
      )
      table.check(
        `receipt_status IN ('NOT_RECEIVED','PARTIALLY_RECEIVED','RECEIVED')`,
        [],
        'purchase_orders_receipt_check'
      )
      table.check(
        `invoice_status IN ('NOT_INVOICED','PARTIALLY_INVOICED','INVOICED')`,
        [],
        'purchase_orders_invoice_check'
      )
      table.check(
        `approval_status NOT IN ('PENDING_APPROVAL','APPROVED')
         OR (submitted_at IS NOT NULL AND total_functional IS NOT NULL AND required_levels IS NOT NULL
             AND exchange_rate IS NOT NULL)`,
        [],
        'purchase_orders_submitted_check'
      )
      table.check(
        `(number IS NULL) = (issued_revision IS NULL) AND (issued_revision IS NULL) = (issued_at IS NULL)`,
        [],
        'purchase_orders_issued_check'
      )
      table.check(
        'issued_revision IS NULL OR issued_revision <= revision',
        [],
        'purchase_orders_issued_revision_check'
      )
      table.check(
        `approval_status <> 'REJECTED' OR reject_reason IS NOT NULL`,
        [],
        'purchase_orders_reject_check'
      )
      table.check(
        `approval_status <> 'CANCELLED' OR cancel_reason IS NOT NULL`,
        [],
        'purchase_orders_cancel_check'
      )
      table.check('(closed_at IS NULL) = (close_reason IS NULL)', [], 'purchase_orders_close_check')
      table.check(
        `total_net = total_gross - total_discount AND total_amount = total_net + total_tax
         AND total_discount >= 0 AND total_tax >= 0`,
        [],
        'purchase_orders_totals_check'
      )
      table.check(
        'payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365',
        [],
        'purchase_orders_terms_check'
      )
    })

    createTenantTable(this, 'purchase_order_lines', (table) => {
      table.uuid('order_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').nullable()
      table.uuid('variant_id').nullable()
      table.string('description', 300).notNullable()
      table.uuid('uom_id').nullable()
      table.string('uom_code', 20).nullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('unit_price', 20, 6).notNullable()
      table.decimal('discount_rate', 6, 3).notNullable().defaultTo(0)
      table.decimal('tax_rate', 6, 3).notNullable().defaultTo(0)
      table.decimal('gross_amount', 20, 2).notNullable()
      table.decimal('discount_amount', 20, 2).notNullable()
      table.decimal('net_amount', 20, 2).notNullable()
      table.decimal('tax_amount', 20, 2).notNullable()
      table.decimal('total_amount', 20, 2).notNullable()
      table.date('expected_date').nullable()
      table.uuid('requisition_line_id').nullable()
      table.uuid('award_line_id').nullable()
      table.decimal('allocated_quantity', 18, 6).notNullable().defaultTo(0)
      table.decimal('received_quantity', 18, 6).notNullable().defaultTo(0)
      table.decimal('invoiced_quantity', 18, 6).notNullable().defaultTo(0)
      table.decimal('cancelled_quantity', 18, 6).notNullable().defaultTo(0)
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'uom_id', 'uoms')
      tenantForeignKey(table, 'requisition_line_id', 'purchase_requisition_lines')
      tenantForeignKey(table, 'award_line_id', 'rfq_award_lines')
      table.unique(['tenant_id', 'order_id', 'line_no'], {
        indexName: 'purchase_order_lines_no_unique',
      })
      table.index(['tenant_id', 'order_id'], 'purchase_order_lines_order_index')
      table.index(['tenant_id', 'award_line_id'], 'purchase_order_lines_award_index')
      table.check(
        `quantity > 0 AND unit_price >= 0 AND discount_rate BETWEEN 0 AND 100 AND tax_rate BETWEEN 0 AND 100`,
        [],
        'purchase_order_lines_values_check'
      )
      table.check(
        `net_amount = gross_amount - discount_amount AND total_amount = net_amount + tax_amount
         AND discount_amount >= 0 AND discount_amount <= gross_amount AND tax_amount >= 0`,
        [],
        'purchase_order_lines_totals_check'
      )
      table.check(
        `allocated_quantity >= 0 AND received_quantity >= 0 AND invoiced_quantity >= 0 AND cancelled_quantity >= 0
         AND received_quantity + cancelled_quantity <= quantity AND allocated_quantity <= quantity`,
        [],
        'purchase_order_lines_quantities_check'
      )
    })

    createTenantTable(this, 'purchase_order_approvals', (table) => {
      table.uuid('order_id').notNullable()
      table.integer('revision').notNullable()
      table.integer('round').notNullable()
      table.uuid('level_id').nullable()
      table.string('level_code', 30).notNullable()
      table.integer('sequence').notNullable()
      table.string('decision', 8).notNullable()
      table.uuid('decided_by_membership_id').notNullable()
      table.uuid('decided_by_user_id').notNullable()
      table.string('reason', 500).nullable()
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      tenantForeignKey(table, 'level_id', 'purchase_approval_levels')
      table.unique(['tenant_id', 'order_id', 'round', 'sequence'], {
        indexName: 'purchase_order_approvals_step_unique',
      })
      table.check(`decision IN ('APPROVE','REJECT')`, [], 'purchase_order_approvals_decision_check')
      table.check(
        `decision = 'APPROVE' OR reason IS NOT NULL`,
        [],
        'purchase_order_approvals_reason_check'
      )
    })

    createTenantTable(this, 'purchase_order_revisions', (table) => {
      table.uuid('order_id').notNullable()
      table.integer('revision').notNullable()
      table.string('reason', 500).notNullable()
      table.decimal('total_amount', 20, 2).notNullable()
      table.jsonb('snapshot').notNullable()
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      table.unique(['tenant_id', 'order_id', 'revision'], {
        indexName: 'purchase_order_revisions_unique',
      })
    })

    createTenantTable(this, 'purchase_order_events', (table) => {
      table.uuid('order_id').notNullable()
      table.string('kind', 30).notNullable()
      table.integer('revision').nullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      table.index(['tenant_id', 'order_id'], 'purchase_order_events_order_index')
    })

    for (const t of [
      'purchase_order_approvals',
      'purchase_order_revisions',
      'purchase_order_events',
    ]) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Cabeçalho: nunca se apaga; anulada é final; depois de emitida, número, série, entidade, fornecedor e moeda fixos;
    // fora do rascunho/recusa, o conteúdo comercial não muda (só estados, aprovação, emissão e fecho).
    this.schema.raw(`
      CREATE FUNCTION purchase_orders_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.approval_status = 'CANCELLED' THEN
          RAISE EXCEPTION 'PURCHASE_ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.number IS NOT NULL AND (NEW.number IS DISTINCT FROM OLD.number
             OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
             OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.currency IS DISTINCT FROM OLD.currency
             OR NEW.revision < OLD.revision) THEN
          RAISE EXCEPTION 'PURCHASE_ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.approval_status NOT IN ('DRAFT','REJECTED') AND NEW.revision = OLD.revision AND (
             NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
             OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.cost_center_id IS DISTINCT FROM OLD.cost_center_id
             OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id OR NEW.currency IS DISTINCT FROM OLD.currency
             OR NEW.order_date IS DISTINCT FROM OLD.order_date OR NEW.expected_date IS DISTINCT FROM OLD.expected_date
             OR NEW.payment_terms_days IS DISTINCT FROM OLD.payment_terms_days
             OR NEW.delivery_terms IS DISTINCT FROM OLD.delivery_terms
             OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
             OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
             OR NEW.total_functional IS DISTINCT FROM OLD.total_functional
             OR NEW.required_levels IS DISTINCT FROM OLD.required_levels) THEN
          RAISE EXCEPTION 'PURCHASE_ORDER_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_orders_fixed BEFORE UPDATE OR DELETE
      ON purchase_orders FOR EACH ROW EXECUTE FUNCTION purchase_orders_fixed()`)

    // Linhas: livres em rascunho/recusa (sem baixar do recebido, facturado ou afectado); fora disso só as quantidades
    // recebida, facturada, cancelada e afectada mudam; linhas com movimento nunca se apagam.
    this.schema.raw(`
      CREATE FUNCTION purchase_order_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE st text;
      BEGIN
        SELECT approval_status INTO st FROM purchase_orders WHERE id = COALESCE(OLD.order_id, NEW.order_id);
        IF TG_OP = 'DELETE' THEN
          IF st NOT IN ('DRAFT','REJECTED') OR OLD.received_quantity > 0 OR OLD.invoiced_quantity > 0
             OR OLD.allocated_quantity > 0 THEN
            RAISE EXCEPTION 'PURCHASE_ORDER_LINE_FIXED' USING ERRCODE = '23000';
          END IF;
          RETURN OLD;
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF st NOT IN ('DRAFT','REJECTED') THEN
            RAISE EXCEPTION 'PURCHASE_ORDER_LINE_FIXED' USING ERRCODE = '23000';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
          RAISE EXCEPTION 'PURCHASE_ORDER_LINE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF st IN ('DRAFT','REJECTED') THEN
          IF NEW.quantity < OLD.received_quantity OR NEW.quantity < OLD.invoiced_quantity
             OR (OLD.received_quantity > 0 AND (NEW.product_id IS DISTINCT FROM OLD.product_id
                 OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.uom_id IS DISTINCT FROM OLD.uom_id)) THEN
            RAISE EXCEPTION 'PURCHASE_ORDER_LINE_FIXED' USING ERRCODE = '23000';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
           OR NEW.description IS DISTINCT FROM OLD.description OR NEW.uom_id IS DISTINCT FROM OLD.uom_id
           OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
           OR NEW.discount_rate IS DISTINCT FROM OLD.discount_rate OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate
           OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.line_no IS DISTINCT FROM OLD.line_no
           OR NEW.requisition_line_id IS DISTINCT FROM OLD.requisition_line_id
           OR NEW.award_line_id IS DISTINCT FROM OLD.award_line_id THEN
          RAISE EXCEPTION 'PURCHASE_ORDER_LINE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_order_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_fixed()`)
  }

  async down() {
    for (const t of [
      'purchase_order_events',
      'purchase_order_revisions',
      'purchase_order_approvals',
      'purchase_order_lines',
      'purchase_orders',
    ])
      this.schema.dropTable(t)
    for (const f of [
      'purchase_orders_fixed',
      'purchase_order_lines_fixed',
      'purchase_order_approvals_fixed',
      'purchase_order_revisions_fixed',
      'purchase_order_events_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
