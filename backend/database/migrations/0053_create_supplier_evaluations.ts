import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Avaliação de fornecedores (Prompt 09, bloco 9.11).
 *
 *  - `supplier_evaluation_settings`: pesos dos quatro critérios (qualidade, prazo, conformidade, custo), que somam 100,
 *    uma linha por empresa.
 *  - `supplier_evaluations`: avaliação publicada de um fornecedor num período — fotografia dos pesos, dos indicadores,
 *    do número de provas de cada um, da nota e da classe, com o comentário de quem avaliou. Só de acréscimo: uma
 *    avaliação publicada não muda nem se apaga (uma reavaliação do mesmo período substitui-a, ficando a anterior).
 *  As provas não se copiam: calculam-se das recepções, devoluções, facturas e propostas, e a fotografia guarda o
 *  resultado no momento.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'supplier_evaluation_settings', (table) => {
      table.smallint('quality_weight').notNullable().defaultTo(30)
      table.smallint('delivery_weight').notNullable().defaultTo(30)
      table.smallint('compliance_weight').notNullable().defaultTo(20)
      table.smallint('cost_weight').notNullable().defaultTo(20)
      table.unique(['tenant_id'], { indexName: 'supplier_evaluation_settings_tenant_unique' })
      table.check(
        `quality_weight BETWEEN 0 AND 100 AND delivery_weight BETWEEN 0 AND 100 AND compliance_weight BETWEEN 0 AND 100
         AND cost_weight BETWEEN 0 AND 100 AND quality_weight + delivery_weight + compliance_weight + cost_weight = 100`,
        [],
        'supplier_evaluation_settings_weights_check'
      )
    })

    createTenantTable(this, 'supplier_evaluations', (table) => {
      table.uuid('supplier_id').notNullable()
      table.date('period_from').notNullable()
      table.date('period_to').notNullable()
      table.jsonb('weights').notNullable()
      table.jsonb('indicators').notNullable()
      table.decimal('score', 5, 2).nullable()
      table.string('rating', 1).nullable()
      table.string('comment', 2000).nullable()
      table.uuid('superseded_by_id').nullable()
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      table.index(['tenant_id', 'supplier_id', 'period_to'], 'supplier_evaluations_supplier_index')
      table.check(
        `period_to >= period_from AND (score IS NULL) = (rating IS NULL)
         AND (score IS NULL OR score BETWEEN 0 AND 100) AND (rating IS NULL OR rating IN ('A','B','C','D'))`,
        [],
        'supplier_evaluations_values_check'
      )
    })
    // Uma avaliação em vigor por fornecedor e período (as substituídas ficam no histórico).
    this.schema.raw(`CREATE UNIQUE INDEX supplier_evaluations_current_unique ON supplier_evaluations
      (tenant_id, supplier_id, period_from, period_to) WHERE superseded_by_id IS NULL`)

    // Publicada não muda: só pode ser marcada como substituída (uma vez).
    this.schema.raw(`
      CREATE FUNCTION supplier_evaluations_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.superseded_by_id IS NOT NULL OR NEW.superseded_by_id IS NULL
           OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.period_from <> OLD.period_from
           OR NEW.period_to <> OLD.period_to OR NEW.weights IS DISTINCT FROM OLD.weights
           OR NEW.indicators IS DISTINCT FROM OLD.indicators OR NEW.score IS DISTINCT FROM OLD.score
           OR NEW.rating IS DISTINCT FROM OLD.rating OR NEW.comment IS DISTINCT FROM OLD.comment THEN
          RAISE EXCEPTION 'SUPPLIER_EVALUATION_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER supplier_evaluations_fixed BEFORE UPDATE OR DELETE
      ON supplier_evaluations FOR EACH ROW EXECUTE FUNCTION supplier_evaluations_fixed()`)
  }

  async down() {
    this.schema.dropTable('supplier_evaluations')
    this.schema.dropTable('supplier_evaluation_settings')
    this.schema.raw('DROP FUNCTION supplier_evaluations_fixed()')
  }
}
