import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Contratos de fornecedor (Prompt 09, bloco 9.6).
 *
 *  - `purchase_contracts`: fornecedor, entidade legal, objecto, vigência, valor máximo (líquido, na moeda do contrato) e
 *    valor consumido, prazo de pagamento, renovação (automática ou não, aviso e período), estado (rascunho → em
 *    aprovação → activo, recusado volta a editar-se; activo ↔ suspenso; terminado e anulado finais). O número da série
 *    `PURCHASE_CONTRACT` é dado na aprovação. Caducado/por iniciar derivam das datas.
 *  - `purchase_contract_prices`: tabela de preços (produto ou descrição, unidade, preço unitário líquido).
 *  - `purchase_contract_slas`: níveis de serviço acordados (métrica, objectivo, penalização).
 *  - `purchase_contract_amendments`: adendas e renovações — propostas, aprovadas por outra pessoa e só então aplicadas;
 *    guardam o proposto e o anterior. Uma pendente de cada vez.
 *  - `purchase_contract_consumptions`: consumo pelas ordens de compra (positivo na emissão, negativo na anulação ou
 *    fecho do resto), idempotente, só de acréscimo; o consumido nunca passa o máximo (`CHECK`).
 *  - `purchase_contract_events`: histórico.
 *  Terminado, só aceita devoluções de consumo. Depois de aprovado, o contrato, os preços e os SLA só mudam ao aplicar uma adenda aprovada (marcada na transacção
 *  com `app.contract_amendment`), além do consumo e dos estados.
 *  As ordens de compra ganham `contract_id` (fixo depois de emitida).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'purchase_contracts', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.string('title', 200).notNullable()
      table.text('object').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.date('start_date').notNullable()
      table.date('end_date').notNullable()
      table.decimal('max_amount', 20, 2).notNullable()
      table.decimal('consumed_amount', 20, 2).notNullable().defaultTo(0)
      table.integer('payment_terms_days').nullable()
      table.boolean('auto_renew').notNullable().defaultTo(false)
      table.integer('renewal_notice_days').notNullable().defaultTo(30)
      table.integer('renewal_months').nullable()
      table.text('notes').nullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.integer('amendment_count').notNullable().defaultTo(0)
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('submitted_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.string('reject_reason', 500).nullable()
      table.string('suspend_reason', 500).nullable()
      table.timestamp('terminated_at', { useTz: true }).nullable()
      table.string('termination_reason', 500).nullable()
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'purchase_contracts_number_unique',
      })
      table.index(['tenant_id', 'supplier_id'], 'purchase_contracts_supplier_index')
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','REJECTED','SUSPENDED','TERMINATED','CANCELLED')`,
        [],
        'purchase_contracts_status_check'
      )
      table.check(
        `end_date >= start_date AND max_amount > 0 AND consumed_amount >= 0 AND consumed_amount <= max_amount`,
        [],
        'purchase_contracts_values_check'
      )
      table.check(
        `(payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365)
         AND renewal_notice_days BETWEEN 0 AND 365 AND (renewal_months IS NULL OR renewal_months BETWEEN 1 AND 120)`,
        [],
        'purchase_contracts_terms_check'
      )
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','REJECTED','CANCELLED')
         OR (number IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS NOT NULL AND approved_by <> submitted_by)`,
        [],
        'purchase_contracts_approved_check'
      )
      table.check(
        `status <> 'PENDING_APPROVAL' OR submitted_at IS NOT NULL`,
        [],
        'purchase_contracts_submitted_check'
      )
      table.check(
        `status <> 'REJECTED' OR reject_reason IS NOT NULL`,
        [],
        'purchase_contracts_reject_check'
      )
      table.check(
        `status <> 'SUSPENDED' OR suspend_reason IS NOT NULL`,
        [],
        'purchase_contracts_suspend_check'
      )
      table.check(
        `(status = 'TERMINATED') = (terminated_at IS NOT NULL AND termination_reason IS NOT NULL)`,
        [],
        'purchase_contracts_terminated_check'
      )
      table.check(
        `status <> 'CANCELLED' OR cancel_reason IS NOT NULL`,
        [],
        'purchase_contracts_cancel_check'
      )
    })

    createTenantTable(this, 'purchase_contract_prices', (table) => {
      table.uuid('contract_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').nullable()
      table.uuid('variant_id').nullable()
      table.string('description', 300).notNullable()
      table.uuid('uom_id').nullable()
      table.string('uom_code', 20).nullable()
      table.decimal('unit_price', 20, 6).notNullable()
      table.string('notes', 500).nullable()
      tenantForeignKey(table, 'contract_id', 'purchase_contracts')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'uom_id', 'uoms')
      table.unique(['tenant_id', 'contract_id', 'line_no'], {
        indexName: 'purchase_contract_prices_no_unique',
      })
      table.check('unit_price >= 0', [], 'purchase_contract_prices_value_check')
    })
    // O mesmo produto/variante só uma vez na tabela de preços.
    this.schema
      .raw(`CREATE UNIQUE INDEX purchase_contract_prices_product_unique ON purchase_contract_prices
      (tenant_id, contract_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE product_id IS NOT NULL`)

    createTenantTable(this, 'purchase_contract_slas', (table) => {
      table.uuid('contract_id').notNullable()
      table.integer('line_no').notNullable()
      table.string('metric', 20).notNullable()
      table.decimal('target', 12, 3).notNullable()
      table.string('description', 300).nullable()
      table.string('penalty', 500).nullable()
      tenantForeignKey(table, 'contract_id', 'purchase_contracts')
      table.unique(['tenant_id', 'contract_id', 'line_no'], {
        indexName: 'purchase_contract_slas_no_unique',
      })
      table.check(
        `metric IN ('DELIVERY_DAYS','FILL_RATE','QUALITY_RATE','RESPONSE_HOURS','OTHER')`,
        [],
        'purchase_contract_slas_metric_check'
      )
      table.check('target >= 0', [], 'purchase_contract_slas_target_check')
      table.check(
        `metric <> 'OTHER' OR description IS NOT NULL`,
        [],
        'purchase_contract_slas_other_check'
      )
    })

    createTenantTable(this, 'purchase_contract_amendments', (table) => {
      table.uuid('contract_id').notNullable()
      table.integer('amendment_no').notNullable()
      table.string('kind', 10).notNullable()
      table.string('reason', 500).notNullable()
      table.date('effective_date').notNullable()
      table.jsonb('proposed').notNullable()
      table.jsonb('previous').nullable()
      table.string('status', 10).notNullable().defaultTo('PENDING')
      table.uuid('requested_by').notNullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.uuid('decided_by').nullable()
      table.string('decision_reason', 500).nullable()
      tenantForeignKey(table, 'contract_id', 'purchase_contracts')
      table.unique(['tenant_id', 'contract_id', 'amendment_no'], {
        indexName: 'purchase_contract_amendments_no_unique',
      })
      table.check(`kind IN ('CHANGE','RENEWAL')`, [], 'purchase_contract_amendments_kind_check')
      table.check(
        `status IN ('PENDING','APPROVED','REJECTED','CANCELLED')`,
        [],
        'purchase_contract_amendments_status_check'
      )
      table.check(
        `status IN ('PENDING','CANCELLED')
         OR (decided_at IS NOT NULL AND decided_by IS NOT NULL AND decided_by <> requested_by)`,
        [],
        'purchase_contract_amendments_decided_check'
      )
      table.check(
        `status <> 'APPROVED' OR previous IS NOT NULL`,
        [],
        'purchase_contract_amendments_previous_check'
      )
      table.check(
        `status NOT IN ('REJECTED','CANCELLED') OR decision_reason IS NOT NULL`,
        [],
        'purchase_contract_amendments_reason_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX purchase_contract_amendments_pending_unique
      ON purchase_contract_amendments (tenant_id, contract_id) WHERE status = 'PENDING'`)

    createTenantTable(this, 'purchase_contract_consumptions', (table) => {
      table.uuid('contract_id').notNullable()
      table.uuid('order_id').notNullable()
      table.integer('order_revision').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      table.string('idempotency_key', 120).notNullable()
      tenantForeignKey(table, 'contract_id', 'purchase_contracts')
      tenantForeignKey(table, 'order_id', 'purchase_orders')
      table.unique(['tenant_id', 'idempotency_key'], {
        indexName: 'purchase_contract_consumptions_key_unique',
      })
      table.index(['tenant_id', 'contract_id'], 'purchase_contract_consumptions_contract_index')
      table.check('amount <> 0', [], 'purchase_contract_consumptions_amount_check')
    })

    createTenantTable(this, 'purchase_contract_events', (table) => {
      table.uuid('contract_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'contract_id', 'purchase_contracts')
      table.index(['tenant_id', 'contract_id'], 'purchase_contract_events_contract_index')
    })

    this.schema.alterTable('purchase_orders', (table) => {
      table.uuid('contract_id').nullable()
      tenantForeignKey(table, 'contract_id', 'purchase_contracts')
      table.index(['tenant_id', 'contract_id'], 'purchase_orders_contract_index')
    })

    for (const t of ['purchase_contract_consumptions', 'purchase_contract_events']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Contrato: nunca se apaga; terminado/anulado finais; número/entidade/fornecedor/moeda fixos depois de numerado;
    // fora do rascunho/recusa o conteúdo só muda ao aplicar uma adenda aprovada.
    this.schema.raw(`
      CREATE FUNCTION purchase_contracts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status = 'CANCELLED' THEN
          RAISE EXCEPTION 'PURCHASE_CONTRACT_FIXED' USING ERRCODE = '23000';
        END IF;
        -- Terminado: só devoluções de consumo (anulação/fecho de ordens antigas).
        IF OLD.status = 'TERMINATED' AND (NEW.status <> 'TERMINATED' OR NEW.consumed_amount > OLD.consumed_amount
             OR NEW.terminated_at IS DISTINCT FROM OLD.terminated_at
             OR NEW.termination_reason IS DISTINCT FROM OLD.termination_reason) THEN
          RAISE EXCEPTION 'PURCHASE_CONTRACT_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.number IS NOT NULL AND (NEW.number IS DISTINCT FROM OLD.number
             OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
             OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.currency IS DISTINCT FROM OLD.currency
             OR NEW.amendment_count < OLD.amendment_count) THEN
          RAISE EXCEPTION 'PURCHASE_CONTRACT_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status NOT IN ('DRAFT','REJECTED')
           AND coalesce(current_setting('app.contract_amendment', true), '') <> OLD.id::text
           AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.object IS DISTINCT FROM OLD.object
             OR NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date
             OR NEW.max_amount IS DISTINCT FROM OLD.max_amount
             OR NEW.payment_terms_days IS DISTINCT FROM OLD.payment_terms_days
             OR NEW.auto_renew IS DISTINCT FROM OLD.auto_renew OR NEW.renewal_months IS DISTINCT FROM OLD.renewal_months
             OR NEW.renewal_notice_days IS DISTINCT FROM OLD.renewal_notice_days
             OR NEW.amendment_count IS DISTINCT FROM OLD.amendment_count) THEN
          RAISE EXCEPTION 'PURCHASE_CONTRACT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_contracts_fixed BEFORE UPDATE OR DELETE
      ON purchase_contracts FOR EACH ROW EXECUTE FUNCTION purchase_contracts_fixed()`)

    // Preços e SLA: livres em rascunho/recusa; depois só ao aplicar uma adenda aprovada.
    for (const t of ['purchase_contract_prices', 'purchase_contract_slas']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE st text; cid uuid;
        BEGIN
          cid := COALESCE(NEW.contract_id, OLD.contract_id);
          SELECT status INTO st FROM purchase_contracts WHERE id = cid;
          IF st NOT IN ('DRAFT','REJECTED')
             AND coalesce(current_setting('app.contract_amendment', true), '') <> cid::text THEN
            RAISE EXCEPTION 'PURCHASE_CONTRACT_FIXED' USING ERRCODE = '23000';
          END IF;
          RETURN COALESCE(NEW, OLD);
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE INSERT OR UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Adendas: só se decide uma pendente (estado e decisão); decididas imutáveis; nunca se apagam.
    this.schema.raw(`
      CREATE FUNCTION purchase_contract_amendments_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status <> 'PENDING'
           OR NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.amendment_no IS DISTINCT FROM OLD.amendment_no
           OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.reason IS DISTINCT FROM OLD.reason
           OR NEW.proposed IS DISTINCT FROM OLD.proposed OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
           OR NEW.effective_date IS DISTINCT FROM OLD.effective_date THEN
          RAISE EXCEPTION 'PURCHASE_CONTRACT_AMENDMENT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_contract_amendments_fixed BEFORE UPDATE OR DELETE
      ON purchase_contract_amendments FOR EACH ROW EXECUTE FUNCTION purchase_contract_amendments_fixed()`)

    // Ordens de compra: o contrato também fica fixo depois de emitida e fora do rascunho/recusa.
    this.schema.raw(ORDER_FIXED(true))
  }

  async down() {
    this.schema.raw(ORDER_FIXED(false))
    this.schema.alterTable('purchase_orders', (table) => {
      // A coluna leva consigo a chave estrangeira e o índice.
      table.dropColumn('contract_id')
    })
    for (const t of [
      'purchase_contract_events',
      'purchase_contract_consumptions',
      'purchase_contract_amendments',
      'purchase_contract_slas',
      'purchase_contract_prices',
      'purchase_contracts',
    ])
      this.schema.dropTable(t)
    for (const f of [
      'purchase_contracts_fixed',
      'purchase_contract_prices_fixed',
      'purchase_contract_slas_fixed',
      'purchase_contract_amendments_fixed',
      'purchase_contract_consumptions_fixed',
      'purchase_contract_events_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}

/** Função de imutabilidade das ordens de compra, com ou sem o contrato (9.6). */
function ORDER_FIXED(withContract: boolean) {
  const contractAfterNumber = withContract
    ? 'OR NEW.contract_id IS DISTINCT FROM OLD.contract_id'
    : ''
  const contractContent = withContract ? 'OR NEW.contract_id IS DISTINCT FROM OLD.contract_id' : ''
  return `
    CREATE OR REPLACE FUNCTION purchase_orders_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR OLD.approval_status = 'CANCELLED' THEN
        RAISE EXCEPTION 'PURCHASE_ORDER_FIXED' USING ERRCODE = '23000';
      END IF;
      IF OLD.number IS NOT NULL AND (NEW.number IS DISTINCT FROM OLD.number
           OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
           OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.currency IS DISTINCT FROM OLD.currency
           ${contractAfterNumber}
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
           OR NEW.required_levels IS DISTINCT FROM OLD.required_levels
           ${contractContent}) THEN
        RAISE EXCEPTION 'PURCHASE_ORDER_FIXED' USING ERRCODE = '23000';
      END IF;
      RETURN NEW;
    END $$`
}
