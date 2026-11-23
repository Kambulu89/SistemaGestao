import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Compras ↔ orçamento, obrigações a pagar e contabilidade (Prompt 09, bloco 9.10).
 *
 *  - `procurement_budgets`: verba de compras por centro de custo e ano (moeda funcional da entidade), com controlo
 *    BLOCK (recusa o que passa a verba) ou WARN (deixa passar e mostra o excesso).
 *  - `procurement_commitments`: livro só de acréscimo por centro de custo e ano. COMMITMENT = o que está comprometido
 *    em aberto (requisições aprovadas por encomendar + ordens emitidas por facturar), ACTUAL = o realizado (facturas
 *    validadas − notas de crédito). Cada documento grava só a diferença para o seu valor actual, por isso a soma é sempre
 *    o estado e a mesma verba nunca fica bloqueada duas vezes (a ordem tira à requisição o que encomenda).
 *  - `procurement_payables`: a obrigação a pagar, **uma** por factura validada (único), na moeda e ao câmbio da factura.
 *  - `procurement_payments`: pagamentos registados (só de acréscimo), nunca acima do saldo, por conta bancária activa
 *    da entidade na moeda da factura, com o câmbio da data do pagamento.
 *  - `procurement_accounting_events`: eventos enviados ao motor de contabilização (origem `PROCUREMENT`): factura, nota
 *    de crédito e pagamento, com chave idempotente; falhados repetem-se sem bloquear o documento.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'procurement_budgets', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('cost_center_id').notNullable()
      table.integer('fiscal_year').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      table.string('control', 8).notNullable().defaultTo('BLOCK')
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.unique(['tenant_id', 'cost_center_id', 'fiscal_year'], {
        indexName: 'procurement_budgets_unique',
      })
      table.check(
        `amount >= 0 AND fiscal_year BETWEEN 2000 AND 2200 AND control IN ('BLOCK','WARN')`,
        [],
        'procurement_budgets_values_check'
      )
    })

    createTenantTable(this, 'procurement_commitments', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('cost_center_id').notNullable()
      table.integer('fiscal_year').notNullable()
      table.string('kind', 12).notNullable()
      table.string('source_type', 20).notNullable()
      table.uuid('source_id').notNullable()
      table.string('source_ref', 60).nullable()
      table.decimal('amount', 20, 2).notNullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.index(
        ['tenant_id', 'cost_center_id', 'fiscal_year'],
        'procurement_commitments_cc_index'
      )
      table.index(['tenant_id', 'source_type', 'source_id'], 'procurement_commitments_source_index')
      table.check(`kind IN ('COMMITMENT','ACTUAL')`, [], 'procurement_commitments_kind_check')
      table.check(
        `source_type IN ('REQUISITION','ORDER','INVOICE','CREDIT_NOTE') AND amount <> 0`,
        [],
        'procurement_commitments_values_check'
      )
    })

    createTenantTable(this, 'procurement_payables', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.uuid('order_id').notNullable()
      table.uuid('invoice_id').notNullable()
      table.uuid('cost_center_id').nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      table.decimal('exchange_rate', 20, 10).notNullable()
      table.date('due_date').notNullable()
      table.decimal('credited_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('paid_amount', 20, 2).notNullable().defaultTo(0)
      table.string('status', 16).notNullable().defaultTo('OPEN')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      tenantForeignKey(table, 'invoice_id', 'purchase_invoices')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      // Uma única obrigação por factura.
      table.unique(['tenant_id', 'invoice_id'], {
        indexName: 'procurement_payables_invoice_unique',
      })
      table.index(['tenant_id', 'status', 'due_date'], 'procurement_payables_due_index')
      table.check(
        `status IN ('OPEN','PARTIALLY_PAID','SETTLED')`,
        [],
        'procurement_payables_status_check'
      )
      // Notas de crédito nunca acima da factura; o pago nunca acima do valor (o saldo é verificado no serviço).
      table.check(
        `amount > 0 AND credited_amount >= 0 AND paid_amount >= 0 AND credited_amount <= amount AND paid_amount <= amount`,
        [],
        'procurement_payables_values_check'
      )
    })

    createTenantTable(this, 'procurement_payments', (table) => {
      table.uuid('payable_id').notNullable()
      table.uuid('bank_account_id').notNullable()
      table.date('paid_on').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      table.decimal('exchange_rate', 20, 10).notNullable()
      table.decimal('amount_functional', 20, 2).notNullable()
      table.string('reference', 60).notNullable()
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'payable_id', 'procurement_payables')
      tenantForeignKey(table, 'bank_account_id', 'bank_accounts')
      table.index(['tenant_id', 'payable_id'], 'procurement_payments_payable_index')
      table.check('amount > 0 AND amount_functional >= 0', [], 'procurement_payments_values_check')
    })

    createTenantTable(this, 'procurement_accounting_events', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('document_type', 12).notNullable()
      table.uuid('document_id').notNullable()
      table.string('event', 40).notNullable()
      table.string('source_ref', 120).notNullable()
      table.date('occurred_on').notNullable()
      table.decimal('total', 20, 2).notNullable()
      table.jsonb('amounts').notNullable()
      table.uuid('cost_center_id').nullable()
      table.string('third_party_ref', 80).nullable()
      table.string('idempotency_key', 120).notNullable()
      table.string('status', 10).notNullable().defaultTo('PENDING')
      table.uuid('posting_event_id').nullable()
      table.string('error', 500).nullable()
      table.integer('attempts').notNullable().defaultTo(0)
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'posting_event_id', 'posting_events')
      table.unique(['tenant_id', 'idempotency_key'], {
        indexName: 'procurement_accounting_events_key_unique',
      })
      table.index(
        ['tenant_id', 'document_type', 'document_id'],
        'procurement_accounting_events_doc_index'
      )
      table.check(
        `document_type IN ('INVOICE','CREDIT_NOTE','PAYMENT') AND status IN ('PENDING','POSTED','DRAFTED','FAILED')`,
        [],
        'procurement_accounting_events_values_check'
      )
    })

    // Livro de compromissos e pagamentos: só de acréscimo.
    for (const t of ['procurement_commitments', 'procurement_payments']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Obrigação: a factura, o valor, a moeda e o câmbio não mudam; o pago só sobe; nunca se apaga.
    this.schema.raw(`
      CREATE FUNCTION procurement_payables_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.amount <> OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate <> OLD.exchange_rate
           OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
           OR NEW.paid_amount < OLD.paid_amount OR NEW.credited_amount < OLD.credited_amount THEN
          RAISE EXCEPTION 'PROCUREMENT_PAYABLE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER procurement_payables_fixed BEFORE UPDATE OR DELETE
      ON procurement_payables FOR EACH ROW EXECUTE FUNCTION procurement_payables_fixed()`)

    // Evento: o pedido (montantes, chave) não muda — só o resultado do envio; nunca se apaga.
    this.schema.raw(`
      CREATE FUNCTION procurement_accounting_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.amounts IS DISTINCT FROM OLD.amounts OR NEW.event <> OLD.event
           OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.total <> OLD.total
           OR NEW.document_id IS DISTINCT FROM OLD.document_id OR OLD.status IN ('POSTED','DRAFTED') THEN
          RAISE EXCEPTION 'PROCUREMENT_ACCOUNTING_EVENT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER procurement_accounting_events_fixed BEFORE UPDATE OR DELETE
      ON procurement_accounting_events FOR EACH ROW EXECUTE FUNCTION procurement_accounting_events_fixed()`)
  }

  async down() {
    this.schema.dropTable('procurement_accounting_events')
    this.schema.dropTable('procurement_payments')
    this.schema.dropTable('procurement_payables')
    this.schema.dropTable('procurement_commitments')
    this.schema.dropTable('procurement_budgets')
    for (const f of [
      'procurement_commitments_fixed',
      'procurement_payments_fixed',
      'procurement_payables_fixed',
      'procurement_accounting_events_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
