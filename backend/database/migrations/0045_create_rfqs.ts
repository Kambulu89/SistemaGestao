import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Pedidos de cotação (Prompt 09, bloco 9.3).
 *
 *  - `rfqs`: o pedido (entidade, título, especificações, prazo de resposta, condições pedidas, moeda de referência,
 *    envelope fechado), com número ao ser emitido e revisão (cada alteração depois de emitido aumenta-a, com motivo).
 *  - `rfq_lines`: o que se pede cotar (produto ou descrição, quantidade, unidade, especificações, necessidade), com a
 *    linha de requisição de origem quando vem das necessidades consolidadas.
 *  - `rfq_invitations`: fornecedores convidados (um por fornecedor) e se responderam ou declinaram.
 *  - `rfq_quotes` + `rfq_quote_lines`: cada proposta recebida, em versões (a nova substitui a anterior, que fica),
 *    com moeda, validade, prazo e condições; por linha do pedido, a oferta principal e alternativas. O conteúdo de uma
 *    proposta não se altera depois de registado (só o estado: substituída ou retirada).
 *  - `rfq_events`: histórico só de acréscimo.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'rfqs', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('title', 200).notNullable()
      table.text('specifications').nullable()
      table.timestamp('closes_at', { useTz: true }).notNullable()
      table.string('delivery_terms', 500).nullable()
      table.string('payment_terms', 500).nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.boolean('sealed').notNullable().defaultTo(true)
      table.integer('revision').notNullable().defaultTo(0)
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.timestamp('issued_at', { useTz: true }).nullable()
      table.uuid('issued_by').nullable()
      table.timestamp('opened_at', { useTz: true }).nullable()
      table.uuid('opened_by').nullable()
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], { indexName: 'rfqs_number_unique' })
      table.index(['tenant_id', 'status'], 'rfqs_status_index')
      table.check(
        `status IN ('DRAFT','OPEN','CLOSED','AWARDED','CANCELLED')`,
        [],
        'rfqs_status_check'
      )
      table.check(
        `status IN ('DRAFT','CANCELLED') OR (number IS NOT NULL AND issued_at IS NOT NULL)`,
        [],
        'rfqs_issued_check'
      )
      table.check(
        `(status IN ('CLOSED','AWARDED')) = (opened_at IS NOT NULL) OR (status = 'CANCELLED')`,
        [],
        'rfqs_opened_check'
      )
      table.check('revision >= 0', [], 'rfqs_revision_check')
    })

    createTenantTable(this, 'rfq_lines', (table) => {
      table.uuid('rfq_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('requisition_line_id').nullable()
      table.uuid('product_id').nullable()
      table.uuid('variant_id').nullable()
      table.string('description', 300).notNullable()
      table.uuid('uom_id').nullable()
      table.string('uom_code', 20).nullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.string('specifications', 1000).nullable()
      table.date('needed_by').nullable()
      tenantForeignKey(table, 'rfq_id', 'rfqs', 'CASCADE')
      tenantForeignKey(table, 'requisition_line_id', 'purchase_requisition_lines')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'uom_id', 'uoms')
      table.unique(['tenant_id', 'rfq_id', 'line_no'], { indexName: 'rfq_lines_no_unique' })
      table.check('quantity > 0', [], 'rfq_lines_quantity_check')
    })

    createTenantTable(this, 'rfq_invitations', (table) => {
      table.uuid('rfq_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.string('status', 10).notNullable().defaultTo('INVITED')
      table.string('decline_reason', 500).nullable()
      tenantForeignKey(table, 'rfq_id', 'rfqs', 'CASCADE')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      table.unique(['tenant_id', 'rfq_id', 'supplier_id'], { indexName: 'rfq_invitations_unique' })
      table.check(
        `status IN ('INVITED','RESPONDED','DECLINED')`,
        [],
        'rfq_invitations_status_check'
      )
      table.check(
        `(status = 'DECLINED') = (decline_reason IS NOT NULL)`,
        [],
        'rfq_invitations_decline_check'
      )
    })

    createTenantTable(this, 'rfq_quotes', (table) => {
      table.uuid('rfq_id').notNullable()
      table.uuid('invitation_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.integer('quote_version').notNullable()
      table.integer('rfq_revision').notNullable()
      table.string('supplier_reference', 60).nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.date('valid_until').notNullable()
      table.integer('delivery_days').nullable()
      table.integer('payment_terms_days').nullable()
      table.string('notes', 1000).nullable()
      table.decimal('total_net', 20, 2).notNullable()
      table.decimal('total_tax', 20, 2).notNullable()
      table.decimal('total_amount', 20, 2).notNullable()
      table.uuid('attachment_id').nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.string('withdraw_reason', 500).nullable()
      table.uuid('received_by').notNullable()
      tenantForeignKey(table, 'rfq_id', 'rfqs')
      tenantForeignKey(table, 'invitation_id', 'rfq_invitations')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'attachment_id', 'attachments')
      table.unique(['tenant_id', 'rfq_id', 'supplier_id', 'quote_version'], {
        indexName: 'rfq_quotes_version_unique',
      })
      table.check(`status IN ('ACTIVE','SUPERSEDED','WITHDRAWN')`, [], 'rfq_quotes_status_check')
      table.check(
        'total_net >= 0 AND total_tax >= 0 AND total_amount = total_net + total_tax',
        [],
        'rfq_quotes_totals_check'
      )
      table.check(
        '(delivery_days IS NULL OR delivery_days BETWEEN 0 AND 730) AND (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365)',
        [],
        'rfq_quotes_days_check'
      )
      table.check(
        `(status = 'WITHDRAWN') = (withdraw_reason IS NOT NULL)`,
        [],
        'rfq_quotes_withdraw_check'
      )
    })
    // Uma só proposta em vigor por fornecedor e pedido.
    this.schema.raw(`CREATE UNIQUE INDEX rfq_quotes_active_unique
      ON rfq_quotes (tenant_id, rfq_id, supplier_id) WHERE status = 'ACTIVE'`)

    createTenantTable(this, 'rfq_quote_lines', (table) => {
      table.uuid('quote_id').notNullable()
      table.uuid('rfq_line_id').notNullable()
      table.integer('alternative_no').notNullable().defaultTo(0)
      table.string('description', 300).nullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('unit_price', 20, 6).notNullable()
      table.decimal('tax_rate', 6, 3).notNullable().defaultTo(0)
      table.decimal('net_amount', 20, 2).notNullable()
      table.decimal('tax_amount', 20, 2).notNullable()
      table.decimal('total_amount', 20, 2).notNullable()
      table.integer('delivery_days').nullable()
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'quote_id', 'rfq_quotes', 'CASCADE')
      tenantForeignKey(table, 'rfq_line_id', 'rfq_lines')
      table.unique(['tenant_id', 'quote_id', 'rfq_line_id', 'alternative_no'], {
        indexName: 'rfq_quote_lines_unique',
      })
      table.check(
        'alternative_no BETWEEN 0 AND 9 AND quantity > 0 AND unit_price >= 0 AND tax_rate BETWEEN 0 AND 100',
        [],
        'rfq_quote_lines_values_check'
      )
      table.check(
        'alternative_no = 0 OR description IS NOT NULL',
        [],
        'rfq_quote_lines_alternative_check'
      )
      table.check('total_amount = net_amount + tax_amount', [], 'rfq_quote_lines_totals_check')
    })

    createTenantTable(this, 'rfq_events', (table) => {
      table.uuid('rfq_id').notNullable()
      table.string('kind', 30).notNullable()
      table.integer('revision').nullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'rfq_id', 'rfqs')
      table.index(['tenant_id', 'rfq_id'], 'rfq_events_rfq_index')
    })

    // Histórico e linhas de proposta: só acréscimo.
    for (const t of ['rfq_events', 'rfq_quote_lines']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }
    // Proposta registada: só o estado muda (em vigor → substituída ou retirada).
    this.schema.raw(`
      CREATE FUNCTION rfq_quotes_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
           OR NEW.quote_version IS DISTINCT FROM OLD.quote_version OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
           OR NEW.delivery_days IS DISTINCT FROM OLD.delivery_days OR NEW.rfq_revision IS DISTINCT FROM OLD.rfq_revision
           OR NEW.received_by IS DISTINCT FROM OLD.received_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR OLD.status <> 'ACTIVE' THEN
          RAISE EXCEPTION 'RFQ_QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER rfq_quotes_fixed BEFORE UPDATE OR DELETE
      ON rfq_quotes FOR EACH ROW EXECUTE FUNCTION rfq_quotes_fixed()`)
    // Linhas do pedido: livres no rascunho; depois de emitido só a quantidade e as especificações mudam (revisões).
    this.schema.raw(`
      CREATE FUNCTION rfq_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE st text;
      BEGIN
        SELECT status INTO st FROM rfqs WHERE id = COALESCE(OLD.rfq_id, NEW.rfq_id);
        IF st IS DISTINCT FROM 'DRAFT' AND (st IS DISTINCT FROM 'OPEN' OR TG_OP <> 'UPDATE'
           OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.description IS DISTINCT FROM OLD.description
           OR NEW.uom_id IS DISTINCT FROM OLD.uom_id OR NEW.line_no IS DISTINCT FROM OLD.line_no) THEN
          RAISE EXCEPTION 'RFQ_LINE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema.raw(`CREATE TRIGGER rfq_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON rfq_lines FOR EACH ROW EXECUTE FUNCTION rfq_lines_fixed()`)
    // Pedido aberto (envelope) ou fechado: o número, a entidade e a moeda não mudam; os finais não mudam.
    this.schema.raw(`
      CREATE FUNCTION rfqs_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'RFQ_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'DRAFT' AND (NEW.number IS DISTINCT FROM OLD.number
             OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR NEW.currency IS DISTINCT FROM OLD.currency
             OR NEW.sealed IS DISTINCT FROM OLD.sealed OR NEW.revision < OLD.revision
             OR OLD.status IN ('AWARDED','CANCELLED')) THEN
          RAISE EXCEPTION 'RFQ_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER rfqs_fixed BEFORE UPDATE OR DELETE
      ON rfqs FOR EACH ROW EXECUTE FUNCTION rfqs_fixed()`)
  }

  async down() {
    this.schema.dropTable('rfq_events')
    this.schema.dropTable('rfq_quote_lines')
    this.schema.dropTable('rfq_quotes')
    this.schema.dropTable('rfq_invitations')
    this.schema.dropTable('rfq_lines')
    this.schema.dropTable('rfqs')
    for (const f of [
      'rfqs_fixed',
      'rfq_lines_fixed',
      'rfq_quotes_fixed',
      'rfq_quote_lines_fixed',
      'rfq_events_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
