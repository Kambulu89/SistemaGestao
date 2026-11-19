import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Stock (Prompt 08, bloco 8.3).
 *
 *  - `stock_postings`: cabeçalho de cada lançamento de stock (tipo, origem, chave de idempotência única, motivo,
 *    estorno de outro lançamento — no máximo um). Só acréscimo.
 *  - `stock_movements`: linhas do lançamento, cada uma com quantidade com sinal (unidades base, 6 casas) num **balde**
 *    (livre, bloqueado, quarentena, reservado, em trânsito, previsto). Só acréscimo.
 *  - `stock_balances`: saldo por armazém, localização, produto e variante, **derivado** dos movimentos por gatilho;
 *    nenhuma escrita directa é aceite. Cada balde é ≥ 0 e o reservado não excede o livre do armazém (verificado no
 *    fim da transacção).
 */
export default class extends BaseSchema {
  async up() {
    // Localização do mesmo armazém e variante do mesmo produto, garantidos por FK composta.
    this.schema.raw(`ALTER TABLE warehouse_locations
      ADD CONSTRAINT warehouse_locations_warehouse_id_unique UNIQUE (tenant_id, warehouse_id, id)`)
    this.schema.raw(`ALTER TABLE product_variants
      ADD CONSTRAINT product_variants_product_id_unique UNIQUE (tenant_id, product_id, id)`)

    createTenantTable(this, 'stock_postings', (table) => {
      table.string('posting_type', 16).notNullable()
      table.string('idempotency_key', 100).notNullable()
      table.string('request_hash', 64).notNullable()
      table.string('source_type', 30).notNullable()
      table.uuid('source_id').nullable()
      table.string('source_ref', 60).nullable()
      table.string('reason', 300).nullable()
      table.uuid('reversal_of_id').nullable()
      table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.unique(['tenant_id', 'idempotency_key'], {
        indexName: 'stock_postings_idempotency_unique',
      })
      table.unique(['tenant_id', 'reversal_of_id'], { indexName: 'stock_postings_reversal_unique' })
      table.index(['tenant_id', 'source_type', 'source_id'], 'stock_postings_source_index')
      table.check(
        `posting_type IN ('RECEIPT','ISSUE','STATUS_CHANGE','RESERVATION','RELEASE','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT','EXPECTED','REVERSAL')`,
        [],
        'stock_postings_type_check'
      )
      table.check(
        `(posting_type = 'REVERSAL') = (reversal_of_id IS NOT NULL)`,
        [],
        'stock_postings_reversal_check'
      )
    })
    this.schema.raw(`ALTER TABLE stock_postings ADD CONSTRAINT stock_postings_reversal_fk
      FOREIGN KEY (tenant_id, reversal_of_id) REFERENCES stock_postings (tenant_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'stock_movements', (table) => {
      table.uuid('posting_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('warehouse_id').notNullable()
      table.uuid('location_id').nullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.string('bucket', 12).notNullable()
      table.decimal('quantity', 20, 6).notNullable()
      table.timestamp('occurred_at', { useTz: true }).notNullable()
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'product_id', 'products')
      table.unique(['tenant_id', 'posting_id', 'line_no'], {
        indexName: 'stock_movements_line_unique',
      })
      table.index(
        ['tenant_id', 'product_id', 'warehouse_id', 'occurred_at'],
        'stock_movements_ledger_index'
      )
      table.index(['tenant_id', 'warehouse_id', 'occurred_at'], 'stock_movements_warehouse_index')
      table.check(
        `bucket IN ('UNRESTRICTED','BLOCKED','QUARANTINE','RESERVED','IN_TRANSIT','EXPECTED')`,
        [],
        'stock_movements_bucket_check'
      )
      table.check('quantity <> 0', [], 'stock_movements_quantity_check')
    })
    this.schema.raw(`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_location_fk
      FOREIGN KEY (tenant_id, warehouse_id, location_id)
      REFERENCES warehouse_locations (tenant_id, warehouse_id, id) ON DELETE RESTRICT`)
    this.schema.raw(`ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_variant_fk
      FOREIGN KEY (tenant_id, product_id, variant_id)
      REFERENCES product_variants (tenant_id, product_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'stock_balances', (table) => {
      table.uuid('warehouse_id').notNullable()
      table.uuid('location_id').nullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      for (const c of [
        'unrestricted',
        'blocked',
        'quarantine',
        'reserved',
        'in_transit',
        'expected',
      ])
        table.decimal(`qty_${c}`, 20, 6).notNullable().defaultTo(0)
      table.timestamp('last_movement_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'product_id', 'products')
      table.index(['tenant_id', 'product_id'], 'stock_balances_product_index')
      for (const c of [
        'unrestricted',
        'blocked',
        'quarantine',
        'reserved',
        'in_transit',
        'expected',
      ])
        table.check(`qty_${c} >= 0`, [], `stock_balances_${c}_check`)
    })
    this.schema.raw(`ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_key_unique
      UNIQUE NULLS NOT DISTINCT (tenant_id, warehouse_id, location_id, product_id, variant_id)`)
    this.schema.raw(`ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_location_fk
      FOREIGN KEY (tenant_id, warehouse_id, location_id)
      REFERENCES warehouse_locations (tenant_id, warehouse_id, id) ON DELETE RESTRICT`)
    this.schema.raw(`ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_variant_fk
      FOREIGN KEY (tenant_id, product_id, variant_id)
      REFERENCES product_variants (tenant_id, product_id, id) ON DELETE RESTRICT`)

    // Lançamentos e movimentos: só acréscimo.
    this.schema.raw(`
      CREATE FUNCTION stock_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'STOCK_APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    for (const t of ['stock_postings', 'stock_movements'])
      this.schema.raw(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION stock_append_only()`)

    // Saldo derivado: cada movimento soma a quantidade ao balde do seu saldo (criado se não existir).
    this.schema.raw(`
      CREATE FUNCTION stock_movements_apply() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        u numeric := CASE WHEN NEW.bucket = 'UNRESTRICTED' THEN NEW.quantity ELSE 0 END;
        b numeric := CASE WHEN NEW.bucket = 'BLOCKED' THEN NEW.quantity ELSE 0 END;
        q numeric := CASE WHEN NEW.bucket = 'QUARANTINE' THEN NEW.quantity ELSE 0 END;
        r numeric := CASE WHEN NEW.bucket = 'RESERVED' THEN NEW.quantity ELSE 0 END;
        t numeric := CASE WHEN NEW.bucket = 'IN_TRANSIT' THEN NEW.quantity ELSE 0 END;
        e numeric := CASE WHEN NEW.bucket = 'EXPECTED' THEN NEW.quantity ELSE 0 END;
      BEGIN
        -- Primeiro actualiza (um INSERT ... ON CONFLICT verificaria os CHECK na linha proposta, com a quantidade
        -- negativa, antes de detectar o conflito); se não houver saldo, cria-o (com nova tentativa se outro o criou).
        LOOP
          UPDATE stock_balances SET
            qty_unrestricted = qty_unrestricted + u,
            qty_blocked = qty_blocked + b,
            qty_quarantine = qty_quarantine + q,
            qty_reserved = qty_reserved + r,
            qty_in_transit = qty_in_transit + t,
            qty_expected = qty_expected + e,
            last_movement_at = NEW.occurred_at,
            updated_at = now(),
            updated_by = NEW.created_by,
            version = version + 1
          WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id AND product_id = NEW.product_id
            AND location_id IS NOT DISTINCT FROM NEW.location_id AND variant_id IS NOT DISTINCT FROM NEW.variant_id;
          EXIT WHEN FOUND;
          BEGIN
            INSERT INTO stock_balances (tenant_id, warehouse_id, location_id, product_id, variant_id,
                qty_unrestricted, qty_blocked, qty_quarantine, qty_reserved, qty_in_transit, qty_expected,
                last_movement_at, created_by, updated_by)
              VALUES (NEW.tenant_id, NEW.warehouse_id, NEW.location_id, NEW.product_id, NEW.variant_id,
                u, b, q, r, t, e, NEW.occurred_at, NEW.created_by, NEW.created_by);
            EXIT;
          EXCEPTION WHEN unique_violation THEN
            -- Criado entretanto por outra transacção: volta a actualizar.
          END;
        END LOOP;
        RETURN NULL;
      END $$`)
    this.schema.raw(`CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
      FOR EACH ROW EXECUTE FUNCTION stock_movements_apply()`)

    // Nenhuma escrita directa nos saldos: só a partir do gatilho dos movimentos (profundidade > 1).
    this.schema.raw(`
      CREATE FUNCTION stock_balances_derived() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'STOCK_BALANCE_DERIVED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER stock_balances_derived BEFORE INSERT OR UPDATE OR DELETE ON stock_balances
      FOR EACH ROW EXECUTE FUNCTION stock_balances_derived()`)

    // Reservado ≤ livre por armazém, produto e variante — verificado no fim da transacção (a ordem das linhas de um
    // lançamento não importa).
    this.schema.raw(`
      CREATE FUNCTION stock_balances_reserved() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE free numeric;
      BEGIN
        SELECT sum(qty_unrestricted) - sum(qty_reserved) INTO free FROM stock_balances
          WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id AND product_id = NEW.product_id
            AND variant_id IS NOT DISTINCT FROM NEW.variant_id;
        IF free < 0 THEN
          RAISE EXCEPTION 'STOCK_OVER_RESERVED' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$`)
    this.schema
      .raw(`CREATE CONSTRAINT TRIGGER stock_balances_reserved AFTER INSERT OR UPDATE ON stock_balances
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_balances_reserved()`)
  }

  async down() {
    this.schema.dropTable('stock_balances')
    this.schema.dropTable('stock_movements')
    this.schema.dropTable('stock_postings')
    this.schema.raw('DROP FUNCTION stock_balances_reserved()')
    this.schema.raw('DROP FUNCTION stock_balances_derived()')
    this.schema.raw('DROP FUNCTION stock_movements_apply()')
    this.schema.raw('DROP FUNCTION stock_append_only()')
    this.schema.raw(
      'ALTER TABLE product_variants DROP CONSTRAINT product_variants_product_id_unique'
    )
    this.schema.raw(
      'ALTER TABLE warehouse_locations DROP CONSTRAINT warehouse_locations_warehouse_id_unique'
    )
  }
}
