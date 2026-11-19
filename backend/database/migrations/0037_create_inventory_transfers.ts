import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Transferências entre armazéns (Prompt 08, bloco 8.5).
 *
 *  - `stock_transfers`: origem e destino (armazéns e entidades legais), intragrupo quando as entidades diferem (com
 *    referência do documento comercial e aceitação do destino), série e número (na aprovação), estado e marcas de cada
 *    passo (pedido, aprovação, aceitação, separação, expedição, recepção, fecho, rejeição, anulação).
 *  - `stock_transfer_lines`: produto/variante, quantidade em unidades base, localização e estado de origem, localização
 *    de destino, lote e séries; quantidades separada, expedida, recebida e perdida.
 *  - `stock_transfer_events` (+ linhas): reserva, libertação, expedição, recepção e perda, cada um com o seu lançamento
 *    de stock e chave de idempotência. Só acréscimo.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'stock_transfers', (table) => {
      table.uuid('source_warehouse_id').notNullable()
      table.uuid('dest_warehouse_id').notNullable()
      table.uuid('source_legal_entity_id').notNullable()
      table.uuid('dest_legal_entity_id').notNullable()
      table.boolean('intercompany').notNullable().defaultTo(false)
      table.string('intercompany_ref', 60).nullable()
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.date('requested_date').notNullable()
      table.date('expected_date').nullable()
      table.string('notes', 500).nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.uuid('submitted_by').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.uuid('accepted_by').nullable()
      table.timestamp('accepted_at', { useTz: true }).nullable()
      table.uuid('picked_by').nullable()
      table.timestamp('picked_at', { useTz: true }).nullable()
      table.uuid('dispatched_by').nullable()
      table.timestamp('dispatched_at', { useTz: true }).nullable()
      table.string('carrier', 120).nullable()
      table.string('tracking_ref', 60).nullable()
      table.timestamp('completed_at', { useTz: true }).nullable()
      table.string('close_reason', 300).nullable()
      table.string('reject_reason', 300).nullable()
      table.string('cancel_reason', 300).nullable()
      tenantForeignKey(table, 'source_warehouse_id', 'warehouses')
      tenantForeignKey(table, 'dest_warehouse_id', 'warehouses')
      tenantForeignKey(table, 'source_legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'dest_legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'stock_transfers_number_unique',
      })
      table.index(['tenant_id', 'source_warehouse_id', 'status'], 'stock_transfers_source_index')
      table.index(['tenant_id', 'dest_warehouse_id', 'status'], 'stock_transfers_dest_index')
      table.check(
        `status IN ('DRAFT','REQUESTED','APPROVED','PICKED','IN_TRANSIT','PARTIAL','RECEIVED','REJECTED','CANCELLED')`,
        [],
        'stock_transfers_status_check'
      )
      table.check('source_warehouse_id <> dest_warehouse_id', [], 'stock_transfers_distinct_check')
      table.check(
        'intercompany = (source_legal_entity_id <> dest_legal_entity_id)',
        [],
        'stock_transfers_intercompany_check'
      )
      table.check('(number IS NULL) = (series_id IS NULL)', [], 'stock_transfers_number_check')
      table.check(
        `(status = 'CANCELLED') = (cancel_reason IS NOT NULL)`,
        [],
        'stock_transfers_cancel_check'
      )
      table.check(
        `(status = 'REJECTED') = (reject_reason IS NOT NULL)`,
        [],
        'stock_transfers_reject_check'
      )
      table.check(
        `status NOT IN ('IN_TRANSIT','PARTIAL','RECEIVED') OR NOT intercompany OR intercompany_ref IS NOT NULL`,
        [],
        'stock_transfers_intercompany_ref_check'
      )
    })

    createTenantTable(this, 'stock_transfer_lines', (table) => {
      table.uuid('transfer_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.decimal('quantity', 20, 6).notNullable()
      table.uuid('source_warehouse_id').notNullable()
      table.uuid('source_location_id').nullable()
      table.string('source_bucket', 12).notNullable().defaultTo('UNRESTRICTED')
      table.uuid('dest_warehouse_id').notNullable()
      table.uuid('dest_location_id').nullable()
      table.string('lot_code', 40).nullable()
      table.jsonb('serials').nullable()
      table.decimal('picked_quantity', 20, 6).nullable()
      table.decimal('shipped_quantity', 20, 6).notNullable().defaultTo(0)
      table.decimal('received_quantity', 20, 6).notNullable().defaultTo(0)
      table.decimal('lost_quantity', 20, 6).notNullable().defaultTo(0)
      tenantForeignKey(table, 'transfer_id', 'stock_transfers', 'CASCADE')
      tenantForeignKey(table, 'product_id', 'products')
      table.unique(['tenant_id', 'transfer_id', 'line_no'], {
        indexName: 'stock_transfer_lines_no_unique',
      })
      table.index(['tenant_id', 'product_id'], 'stock_transfer_lines_product_index')
      table.check(
        `source_bucket IN ('UNRESTRICTED','BLOCKED','QUARANTINE')`,
        [],
        'stock_transfer_lines_bucket_check'
      )
      table.check('quantity > 0', [], 'stock_transfer_lines_qty_check')
      table.check(
        'picked_quantity IS NULL OR (picked_quantity >= 0 AND picked_quantity <= quantity)',
        [],
        'stock_transfer_lines_picked_check'
      )
      table.check(
        'shipped_quantity >= 0 AND shipped_quantity <= quantity AND received_quantity >= 0 AND lost_quantity >= 0 AND received_quantity + lost_quantity <= shipped_quantity',
        [],
        'stock_transfer_lines_flow_check'
      )
    })
    for (const [col, wh] of [
      ['source_location_id', 'source_warehouse_id'],
      ['dest_location_id', 'dest_warehouse_id'],
    ])
      this.schema
        .raw(`ALTER TABLE stock_transfer_lines ADD CONSTRAINT stock_transfer_lines_${col}_fk
        FOREIGN KEY (tenant_id, ${wh}, ${col}) REFERENCES warehouse_locations (tenant_id, warehouse_id, id)
        ON DELETE RESTRICT`)
    this.schema.raw(`ALTER TABLE stock_transfer_lines ADD CONSTRAINT stock_transfer_lines_variant_fk
      FOREIGN KEY (tenant_id, product_id, variant_id) REFERENCES product_variants (tenant_id, product_id, id)
      ON DELETE RESTRICT`)

    createTenantTable(this, 'stock_transfer_events', (table) => {
      table.uuid('transfer_id').notNullable()
      table.string('kind', 10).notNullable()
      table.string('idempotency_key', 100).notNullable()
      table.uuid('posting_id').notNullable()
      table.string('reason', 300).nullable()
      tenantForeignKey(table, 'transfer_id', 'stock_transfers')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      table.unique(['tenant_id', 'transfer_id', 'idempotency_key'], {
        indexName: 'stock_transfer_events_key_unique',
      })
      table.check(
        `kind IN ('RESERVE','RELEASE','DISPATCH','RECEIVE','LOSS')`,
        [],
        'stock_transfer_events_kind_check'
      )
    })
    createTenantTable(this, 'stock_transfer_event_lines', (table) => {
      table.uuid('event_id').notNullable()
      table.uuid('line_id').notNullable()
      table.decimal('quantity', 20, 6).notNullable()
      table.uuid('dest_location_id').nullable()
      tenantForeignKey(table, 'event_id', 'stock_transfer_events')
      tenantForeignKey(table, 'line_id', 'stock_transfer_lines')
      table.unique(['tenant_id', 'event_id', 'line_id'], {
        indexName: 'stock_transfer_event_lines_unique',
      })
      table.check('quantity > 0', [], 'stock_transfer_event_lines_qty_check')
    })

    this.schema.raw(`
      CREATE FUNCTION stock_transfer_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'TRANSFER_EVENT_FIXED' USING ERRCODE = '23000';
      END $$`)
    for (const t of ['stock_transfer_events', 'stock_transfer_event_lines'])
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION stock_transfer_events_fixed()`)
    // Depois de expedida, a linha não muda de produto, quantidade, origem nem lote, e não se apaga.
    this.schema.raw(`
      CREATE FUNCTION stock_transfer_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.shipped_quantity > 0 THEN
          IF TG_OP = 'DELETE' OR NEW.product_id IS DISTINCT FROM OLD.product_id
             OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.quantity IS DISTINCT FROM OLD.quantity
             OR NEW.source_location_id IS DISTINCT FROM OLD.source_location_id
             OR NEW.source_bucket IS DISTINCT FROM OLD.source_bucket OR NEW.lot_code IS DISTINCT FROM OLD.lot_code
             OR NEW.serials IS DISTINCT FROM OLD.serials OR NEW.shipped_quantity IS DISTINCT FROM OLD.shipped_quantity THEN
            RAISE EXCEPTION 'LINE_SHIPPED' USING ERRCODE = '23000';
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER stock_transfer_lines_fixed BEFORE UPDATE OR DELETE ON stock_transfer_lines
      FOR EACH ROW EXECUTE FUNCTION stock_transfer_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('stock_transfer_event_lines')
    this.schema.dropTable('stock_transfer_events')
    this.schema.dropTable('stock_transfer_lines')
    this.schema.dropTable('stock_transfers')
    this.schema.raw('DROP FUNCTION stock_transfer_lines_fixed()')
    this.schema.raw('DROP FUNCTION stock_transfer_events_fixed()')
  }
}
