import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Adjudicação de pedidos de cotação (Prompt 09, bloco 9.4).
 *
 *  - `rfq_awards`: a decisão sobre um pedido fechado — pesos dos critérios (inteiros que somam 100), moeda de base
 *    (funcional da entidade) e data do câmbio (a da abertura das propostas), justificação, total adjudicado na moeda de
 *    base, submissão e decisão (aprovação ou recusa por outra pessoa). Só uma adjudicação viva por pedido.
 *  - `rfq_award_scores`: a nota de qualidade (0–100) dada a cada fornecedor com proposta.
 *  - `rfq_award_lines`: o que se adjudica — linha do pedido, oferta escolhida (principal ou alternativa) e quantidade,
 *    com a fotografia dos valores (preço, câmbio, valores na moeda de base, pontuação) e o motivo quando a escolha não
 *    é a melhor pontuada.
 *  Depois de submetida, a adjudicação, as notas e as linhas não mudam; aprovada ou recusada, nada muda.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'rfq_awards', (table) => {
      table.uuid('rfq_id').notNullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.smallint('price_weight').notNullable()
      table.smallint('delivery_weight').notNullable()
      table.smallint('quality_weight').notNullable()
      table.smallint('payment_weight').notNullable()
      table.specificType('base_currency', 'char(3)').notNullable()
      table.date('rate_date').notNullable()
      table.text('justification').notNullable()
      table.decimal('total_net_base', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_base', 20, 2).notNullable().defaultTo(0)
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('submitted_by').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.uuid('decided_by').nullable()
      table.string('decision_reason', 500).nullable()
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'rfq_id', 'rfqs')
      table.index(['tenant_id', 'rfq_id'], 'rfq_awards_rfq_index')
      table.index(['tenant_id', 'status'], 'rfq_awards_status_index')
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED')`,
        [],
        'rfq_awards_status_check'
      )
      table.check(
        `price_weight BETWEEN 0 AND 100 AND delivery_weight BETWEEN 0 AND 100 AND quality_weight BETWEEN 0 AND 100
         AND payment_weight BETWEEN 0 AND 100
         AND price_weight + delivery_weight + quality_weight + payment_weight = 100`,
        [],
        'rfq_awards_weights_check'
      )
      table.check(
        `status IN ('DRAFT','CANCELLED') OR (submitted_at IS NOT NULL AND submitted_by IS NOT NULL)`,
        [],
        'rfq_awards_submitted_check'
      )
      table.check(
        `status NOT IN ('APPROVED','REJECTED')
         OR (decided_at IS NOT NULL AND decided_by IS NOT NULL AND decided_by <> submitted_by)`,
        [],
        'rfq_awards_decided_check'
      )
      table.check(
        `status <> 'REJECTED' OR decision_reason IS NOT NULL`,
        [],
        'rfq_awards_reject_check'
      )
      table.check(
        `status <> 'CANCELLED' OR cancel_reason IS NOT NULL`,
        [],
        'rfq_awards_cancel_check'
      )
      table.check(`length(trim(justification)) > 0`, [], 'rfq_awards_justification_check')
    })
    // Uma adjudicação viva por pedido (rascunho, em aprovação ou aprovada).
    this.schema.raw(`CREATE UNIQUE INDEX rfq_awards_live_unique ON rfq_awards (tenant_id, rfq_id)
      WHERE status IN ('DRAFT','PENDING_APPROVAL','APPROVED')`)

    createTenantTable(this, 'rfq_award_scores', (table) => {
      table.uuid('award_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.smallint('quality_score').notNullable()
      tenantForeignKey(table, 'award_id', 'rfq_awards', 'CASCADE')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      table.unique(['tenant_id', 'award_id', 'supplier_id'], {
        indexName: 'rfq_award_scores_unique',
      })
      table.check('quality_score BETWEEN 0 AND 100', [], 'rfq_award_scores_value_check')
    })

    createTenantTable(this, 'rfq_award_lines', (table) => {
      table.uuid('award_id').notNullable()
      table.uuid('rfq_line_id').notNullable()
      table.uuid('quote_id').notNullable()
      table.uuid('quote_line_id').notNullable()
      table.uuid('supplier_id').notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('unit_price', 20, 6).notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('rate', 20, 10).notNullable()
      table.decimal('unit_price_base', 20, 6).notNullable()
      table.decimal('net_base', 20, 2).notNullable()
      table.decimal('total_base', 20, 2).notNullable()
      table.decimal('score', 6, 2).notNullable()
      table.boolean('best').notNullable()
      table.string('reason', 500).nullable()
      tenantForeignKey(table, 'award_id', 'rfq_awards', 'CASCADE')
      tenantForeignKey(table, 'rfq_line_id', 'rfq_lines')
      tenantForeignKey(table, 'quote_id', 'rfq_quotes')
      tenantForeignKey(table, 'quote_line_id', 'rfq_quote_lines')
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      table.unique(['tenant_id', 'award_id', 'quote_line_id'], {
        indexName: 'rfq_award_lines_unique',
      })
      table.index(['tenant_id', 'award_id'], 'rfq_award_lines_award_index')
      table.check(
        'quantity > 0 AND unit_price >= 0 AND rate > 0 AND total_base >= net_base AND score BETWEEN 0 AND 100',
        [],
        'rfq_award_lines_values_check'
      )
      table.check('best OR reason IS NOT NULL', [], 'rfq_award_lines_reason_check')
    })

    // Cabeçalho: livre no rascunho; em aprovação só a decisão ou a anulação; finais imutáveis; nunca se apaga.
    this.schema.raw(`
      CREATE FUNCTION rfq_awards_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'RFQ_AWARD_FIXED' USING ERRCODE = '23000';
        END IF;
        IF NEW.rfq_id IS DISTINCT FROM OLD.rfq_id THEN
          RAISE EXCEPTION 'RFQ_AWARD_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('APPROVED','REJECTED','CANCELLED') THEN
          RAISE EXCEPTION 'RFQ_AWARD_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'PENDING_APPROVAL' AND (
             NEW.status NOT IN ('APPROVED','REJECTED','CANCELLED')
             OR NEW.price_weight IS DISTINCT FROM OLD.price_weight
             OR NEW.delivery_weight IS DISTINCT FROM OLD.delivery_weight
             OR NEW.quality_weight IS DISTINCT FROM OLD.quality_weight
             OR NEW.payment_weight IS DISTINCT FROM OLD.payment_weight
             OR NEW.base_currency IS DISTINCT FROM OLD.base_currency
             OR NEW.rate_date IS DISTINCT FROM OLD.rate_date
             OR NEW.justification IS DISTINCT FROM OLD.justification
             OR NEW.total_net_base IS DISTINCT FROM OLD.total_net_base
             OR NEW.total_base IS DISTINCT FROM OLD.total_base
             OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
             OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by) THEN
          RAISE EXCEPTION 'RFQ_AWARD_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER rfq_awards_fixed BEFORE UPDATE OR DELETE
      ON rfq_awards FOR EACH ROW EXECUTE FUNCTION rfq_awards_fixed()`)
    // Notas e linhas: só enquanto a adjudicação está em rascunho.
    for (const t of ['rfq_award_scores', 'rfq_award_lines']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE st text;
        BEGIN
          SELECT status INTO st FROM rfq_awards WHERE id = COALESCE(OLD.award_id, NEW.award_id);
          IF st IS DISTINCT FROM 'DRAFT' THEN
            RAISE EXCEPTION 'RFQ_AWARD_FIXED' USING ERRCODE = '23000';
          END IF;
          RETURN COALESCE(NEW, OLD);
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE INSERT OR UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }
  }

  async down() {
    this.schema.dropTable('rfq_award_lines')
    this.schema.dropTable('rfq_award_scores')
    this.schema.dropTable('rfq_awards')
    for (const f of ['rfq_awards_fixed', 'rfq_award_scores_fixed', 'rfq_award_lines_fixed'])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
