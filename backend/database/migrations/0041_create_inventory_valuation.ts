import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Valorização do stock (Prompt 08, bloco 8.9).
 *
 *  - `products.valuation_method`: custo médio ponderado, FIFO contabilístico ou custo específico (por lote).
 *  - `stock_valuation_entries`: livro de custo — cada entrada ou saída de valor por entidade legal, produto, variante
 *    (e lote no custo específico), ligada ao lançamento de stock ou a um ajuste de custo. Só acréscimo.
 *  - `stock_cost_pools` (quantidade e valor por entidade/produto/variante) e o que resta de cada camada em
 *    `stock_cost_layers` são **derivados** do livro por gatilho; nenhuma escrita directa é aceite.
 *  - `stock_cost_adjustments`: correcções de custo (preço definitivo, custos de aquisição) sobre o stock existente,
 *    sem tocar no passado. Só acréscimo.
 *  - `inventory_valuation_accounts`: conta do razão de cada classe contabilística por entidade (reconciliação).
 *  - `stock_documents.return_of_document_id`: a devolução sai/entra ao custo do documento original.
 *
 * O stock existente antes do 8.9 entra no livro com valor zero (custo desconhecido), para o livro bater com os saldos;
 * o custo corrige-se com um ajuste.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(
      `ALTER TABLE products ADD COLUMN valuation_method varchar(10) NOT NULL DEFAULT 'AVERAGE'`
    )
    this.schema.raw(`ALTER TABLE products ADD CONSTRAINT products_valuation_check
      CHECK (valuation_method IN ('AVERAGE','FIFO','SPECIFIC') AND (valuation_method <> 'SPECIFIC' OR track_lots))`)

    createTenantTable(this, 'stock_cost_pools', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.decimal('quantity', 20, 6).notNullable().defaultTo(0)
      table.decimal('value', 20, 2).notNullable().defaultTo(0)
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'product_id', 'products')
      table.check('quantity >= 0', [], 'stock_cost_pools_quantity_check')
      table.check('value >= 0', [], 'stock_cost_pools_value_check')
      table.check('quantity > 0 OR value = 0', [], 'stock_cost_pools_empty_check')
    })
    this.schema.raw(`ALTER TABLE stock_cost_pools ADD CONSTRAINT stock_cost_pools_key_unique
      UNIQUE NULLS NOT DISTINCT (tenant_id, legal_entity_id, product_id, variant_id)`)

    createTenantTable(this, 'stock_cost_layers', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.uuid('lot_id').nullable()
      table.uuid('posting_id').nullable()
      table.timestamp('received_at', { useTz: true }).notNullable()
      table.decimal('quantity_in', 20, 6).notNullable()
      table.decimal('value_in', 20, 2).notNullable()
      table.decimal('remaining_quantity', 20, 6).notNullable().defaultTo(0)
      table.decimal('remaining_value', 20, 2).notNullable().defaultTo(0)
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      table.index(
        ['tenant_id', 'legal_entity_id', 'product_id', 'received_at'],
        'stock_cost_layers_fifo_index'
      )
      table.check('quantity_in > 0 AND value_in >= 0', [], 'stock_cost_layers_in_check')
      table.check(
        'remaining_quantity >= 0 AND remaining_value >= 0 AND remaining_quantity <= quantity_in',
        [],
        'stock_cost_layers_remaining_check'
      )
      table.check(
        'remaining_quantity > 0 OR remaining_value = 0',
        [],
        'stock_cost_layers_empty_check'
      )
    })
    this.schema.raw(`ALTER TABLE stock_cost_layers ADD CONSTRAINT stock_cost_layers_lot_fk
      FOREIGN KEY (tenant_id, product_id, lot_id) REFERENCES stock_lots (tenant_id, product_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'stock_cost_adjustments', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.uuid('layer_id').nullable()
      table.decimal('amount', 20, 2).notNullable()
      table.string('reason', 300).notNullable()
      table.string('idempotency_key', 100).notNullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'layer_id', 'stock_cost_layers')
      table.unique(['tenant_id', 'idempotency_key'], {
        indexName: 'stock_cost_adjustments_key_unique',
      })
      table.check('amount <> 0', [], 'stock_cost_adjustments_amount_check')
    })

    createTenantTable(this, 'stock_valuation_entries', (table) => {
      table.uuid('posting_id').nullable()
      table.uuid('adjustment_id').nullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.uuid('lot_id').nullable()
      table.uuid('layer_id').nullable()
      table.string('method', 10).notNullable()
      table.string('source', 12).notNullable()
      table.decimal('quantity', 20, 6).notNullable()
      table.decimal('value', 20, 2).notNullable()
      table.timestamp('occurred_at', { useTz: true }).notNullable()
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      tenantForeignKey(table, 'adjustment_id', 'stock_cost_adjustments')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'layer_id', 'stock_cost_layers')
      table.index(['tenant_id', 'posting_id'], 'stock_valuation_entries_posting_index')
      table.index(
        ['tenant_id', 'legal_entity_id', 'product_id', 'occurred_at'],
        'stock_valuation_entries_ledger_index'
      )
      table.check(
        `method IN ('AVERAGE','FIFO','SPECIFIC')`,
        [],
        'stock_valuation_entries_method_check'
      )
      table.check(
        `source IN ('GIVEN','PAIRED','RETURN','CURRENT','ZERO','AVERAGE','LAYER','REVERSAL','ADJUSTMENT','OPENING')`,
        [],
        'stock_valuation_entries_source_check'
      )
      table.check(
        `(source = 'OPENING' AND posting_id IS NULL AND adjustment_id IS NULL)
          OR (source = 'ADJUSTMENT' AND adjustment_id IS NOT NULL AND posting_id IS NULL AND quantity = 0)
          OR (source NOT IN ('OPENING','ADJUSTMENT') AND posting_id IS NOT NULL AND adjustment_id IS NULL AND quantity <> 0)`,
        [],
        'stock_valuation_entries_origin_check'
      )
      table.check(
        '(quantity > 0 AND value >= 0) OR (quantity < 0 AND value <= 0) OR quantity = 0',
        [],
        'stock_valuation_entries_sign_check'
      )
    })
    this.schema
      .raw(`ALTER TABLE stock_valuation_entries ADD CONSTRAINT stock_valuation_entries_lot_fk
      FOREIGN KEY (tenant_id, product_id, lot_id) REFERENCES stock_lots (tenant_id, product_id, id) ON DELETE RESTRICT`)

    // Livro e ajustes: só acréscimo.
    this.schema.raw(`
      CREATE FUNCTION stock_valuation_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'VALUATION_APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    for (const t of ['stock_valuation_entries', 'stock_cost_adjustments'])
      this.schema.raw(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION stock_valuation_append_only()`)

    // Cada entrada do livro soma ao saldo de custo (e ao que resta da camada).
    this.schema.raw(`
      CREATE FUNCTION stock_valuation_apply() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        LOOP
          UPDATE stock_cost_pools SET quantity = quantity + NEW.quantity, value = value + NEW.value,
              updated_at = now(), updated_by = NEW.created_by, version = version + 1
            WHERE tenant_id = NEW.tenant_id AND legal_entity_id = NEW.legal_entity_id
              AND product_id = NEW.product_id AND variant_id IS NOT DISTINCT FROM NEW.variant_id;
          EXIT WHEN FOUND;
          BEGIN
            INSERT INTO stock_cost_pools (tenant_id, legal_entity_id, product_id, variant_id, quantity, value,
                created_by, updated_by)
              VALUES (NEW.tenant_id, NEW.legal_entity_id, NEW.product_id, NEW.variant_id, NEW.quantity, NEW.value,
                NEW.created_by, NEW.created_by);
            EXIT;
          EXCEPTION WHEN unique_violation THEN
          END;
        END LOOP;
        IF NEW.layer_id IS NOT NULL THEN
          UPDATE stock_cost_layers SET remaining_quantity = remaining_quantity + NEW.quantity,
              remaining_value = remaining_value + NEW.value, updated_at = now(), updated_by = NEW.created_by,
              version = version + 1
            WHERE tenant_id = NEW.tenant_id AND id = NEW.layer_id;
        END IF;
        RETURN NULL;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER stock_valuation_entries_apply AFTER INSERT ON stock_valuation_entries
      FOR EACH ROW EXECUTE FUNCTION stock_valuation_apply()`)
    // Saldos de custo e o restante das camadas só mudam pelo livro (a camada nasce vazia).
    this.schema.raw(`
      CREATE FUNCTION stock_cost_pools_derived() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'COST_DERIVED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`
      CREATE FUNCTION stock_cost_layers_derived() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.remaining_quantity = 0 AND NEW.remaining_value = 0 THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'COST_DERIVED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' OR pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'COST_DERIVED' USING ERRCODE = '23000';
        END IF;
        IF NEW.quantity_in IS DISTINCT FROM OLD.quantity_in OR NEW.value_in IS DISTINCT FROM OLD.value_in
           OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.lot_id IS DISTINCT FROM OLD.lot_id THEN
          RAISE EXCEPTION 'COST_DERIVED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    for (const t of ['stock_cost_pools', 'stock_cost_layers'])
      this.schema.raw(`CREATE TRIGGER ${t}_derived BEFORE INSERT OR UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION ${t}_derived()`)

    createTenantTable(this, 'inventory_valuation_accounts', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('accounting_class', 30).notNullable()
      table.uuid('account_id').notNullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'account_id', 'accounts')
      table.unique(['tenant_id', 'legal_entity_id', 'accounting_class'], {
        indexName: 'inventory_valuation_accounts_unique',
      })
    })

    this.schema.raw('ALTER TABLE stock_documents ADD COLUMN return_of_document_id uuid NULL')
    this.schema.raw(`ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_return_fk
      FOREIGN KEY (tenant_id, return_of_document_id) REFERENCES stock_documents (tenant_id, id) ON DELETE RESTRICT`)

    // Stock anterior ao 8.9: entra no livro com valor zero (custo desconhecido), por entidade legal do armazém.
    this.schema.raw(`
      INSERT INTO stock_valuation_entries (tenant_id, legal_entity_id, product_id, variant_id, method, source, quantity,
          value, occurred_at)
      SELECT b.tenant_id, w.legal_entity_id, b.product_id, b.variant_id, 'AVERAGE', 'OPENING',
             sum(b.qty_unrestricted + b.qty_blocked + b.qty_quarantine + b.qty_in_transit), 0, now()
        FROM stock_balances b JOIN warehouses w ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
       GROUP BY b.tenant_id, w.legal_entity_id, b.product_id, b.variant_id
      HAVING sum(b.qty_unrestricted + b.qty_blocked + b.qty_quarantine + b.qty_in_transit) <> 0`)
  }

  async down() {
    this.schema.raw('ALTER TABLE stock_documents DROP COLUMN return_of_document_id')
    this.schema.dropTable('inventory_valuation_accounts')
    this.schema.dropTable('stock_valuation_entries')
    this.schema.dropTable('stock_cost_adjustments')
    this.schema.dropTable('stock_cost_layers')
    this.schema.dropTable('stock_cost_pools')
    this.schema.raw('DROP FUNCTION stock_cost_layers_derived()')
    this.schema.raw('DROP FUNCTION stock_cost_pools_derived()')
    this.schema.raw('DROP FUNCTION stock_valuation_apply()')
    this.schema.raw('DROP FUNCTION stock_valuation_append_only()')
    this.schema.raw('ALTER TABLE products DROP CONSTRAINT products_valuation_check')
    this.schema.raw('ALTER TABLE products DROP COLUMN valuation_method')
  }
}
