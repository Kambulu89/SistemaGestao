import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Requisições internas (Prompt 08, bloco 8.6).
 *
 *  - `stock_requisitions`: armazém (e a sua entidade legal), departamento requisitante, centro de custo, quem pede,
 *    finalidade, data em que é preciso, série e número (na aprovação), estado e marcas de cada passo e motivos.
 *  - `stock_requisition_lines`: produto/variante, quantidade em unidades base, localização de saída; separado,
 *    entregue (consumido) e libertado.
 *  - `stock_requisition_events` (+ linhas): reserva, entrega e libertação, cada um com o seu lançamento de stock.
 *    Só acréscimo.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'stock_requisitions', (table) => {
      table.uuid('warehouse_id').notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('department_id').notNullable()
      table.uuid('cost_center_id').nullable()
      table.uuid('requested_by_membership_id').notNullable()
      table.string('purpose', 300).notNullable()
      table.date('needed_by').nullable()
      table.string('notes', 500).nullable()
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.uuid('picked_by').nullable()
      table.timestamp('picked_at', { useTz: true }).nullable()
      table.timestamp('completed_at', { useTz: true }).nullable()
      table.string('close_reason', 300).nullable()
      table.string('reject_reason', 300).nullable()
      table.string('cancel_reason', 300).nullable()
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'department_id', 'departments')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'requested_by_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'stock_requisitions_number_unique',
      })
      table.index(['tenant_id', 'department_id', 'status'], 'stock_requisitions_department_index')
      table.index(['tenant_id', 'warehouse_id', 'status'], 'stock_requisitions_warehouse_index')
      table.index(['tenant_id', 'cost_center_id'], 'stock_requisitions_cost_center_index')
      table.check(
        `status IN ('DRAFT','REQUESTED','APPROVED','PICKED','PARTIAL','COMPLETED','REJECTED','CANCELLED')`,
        [],
        'stock_requisitions_status_check'
      )
      table.check('(number IS NULL) = (series_id IS NULL)', [], 'stock_requisitions_number_check')
      table.check(
        `(status = 'CANCELLED') = (cancel_reason IS NOT NULL)`,
        [],
        'stock_requisitions_cancel_check'
      )
      table.check(
        `(status = 'REJECTED') = (reject_reason IS NOT NULL)`,
        [],
        'stock_requisitions_reject_check'
      )
    })

    createTenantTable(this, 'stock_requisition_lines', (table) => {
      table.uuid('requisition_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.decimal('quantity', 20, 6).notNullable()
      table.uuid('warehouse_id').notNullable()
      table.uuid('source_location_id').nullable()
      table.decimal('picked_quantity', 20, 6).nullable()
      table.decimal('issued_quantity', 20, 6).notNullable().defaultTo(0)
      table.decimal('released_quantity', 20, 6).notNullable().defaultTo(0)
      tenantForeignKey(table, 'requisition_id', 'stock_requisitions', 'CASCADE')
      tenantForeignKey(table, 'product_id', 'products')
      table.unique(['tenant_id', 'requisition_id', 'line_no'], {
        indexName: 'stock_requisition_lines_no_unique',
      })
      table.index(['tenant_id', 'product_id'], 'stock_requisition_lines_product_index')
      table.check('quantity > 0', [], 'stock_requisition_lines_qty_check')
      table.check(
        'picked_quantity IS NULL OR (picked_quantity >= 0 AND picked_quantity <= quantity)',
        [],
        'stock_requisition_lines_picked_check'
      )
      table.check(
        'issued_quantity >= 0 AND released_quantity >= 0 AND issued_quantity + released_quantity <= quantity',
        [],
        'stock_requisition_lines_flow_check'
      )
    })
    this.schema
      .raw(`ALTER TABLE stock_requisition_lines ADD CONSTRAINT stock_requisition_lines_location_fk
      FOREIGN KEY (tenant_id, warehouse_id, source_location_id)
      REFERENCES warehouse_locations (tenant_id, warehouse_id, id) ON DELETE RESTRICT`)
    this.schema
      .raw(`ALTER TABLE stock_requisition_lines ADD CONSTRAINT stock_requisition_lines_variant_fk
      FOREIGN KEY (tenant_id, product_id, variant_id) REFERENCES product_variants (tenant_id, product_id, id)
      ON DELETE RESTRICT`)

    createTenantTable(this, 'stock_requisition_events', (table) => {
      table.uuid('requisition_id').notNullable()
      table.string('kind', 8).notNullable()
      table.string('idempotency_key', 100).notNullable()
      table.uuid('posting_id').notNullable()
      table.string('reason', 300).nullable()
      tenantForeignKey(table, 'requisition_id', 'stock_requisitions')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      table.unique(['tenant_id', 'requisition_id', 'idempotency_key'], {
        indexName: 'stock_requisition_events_key_unique',
      })
      table.check(
        `kind IN ('RESERVE','ISSUE','RELEASE')`,
        [],
        'stock_requisition_events_kind_check'
      )
    })
    createTenantTable(this, 'stock_requisition_event_lines', (table) => {
      table.uuid('event_id').notNullable()
      table.uuid('line_id').notNullable()
      table.decimal('quantity', 20, 6).notNullable()
      tenantForeignKey(table, 'event_id', 'stock_requisition_events')
      tenantForeignKey(table, 'line_id', 'stock_requisition_lines')
      table.unique(['tenant_id', 'event_id', 'line_id'], {
        indexName: 'stock_requisition_event_lines_unique',
      })
      table.check('quantity > 0', [], 'stock_requisition_event_lines_qty_check')
    })

    this.schema.raw(`
      CREATE FUNCTION stock_requisition_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'REQUISITION_EVENT_FIXED' USING ERRCODE = '23000';
      END $$`)
    for (const t of ['stock_requisition_events', 'stock_requisition_event_lines'])
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION stock_requisition_events_fixed()`)
    // Depois da reserva (aprovação) a linha não muda de produto, quantidade nem localização, e não se apaga.
    this.schema.raw(`
      CREATE FUNCTION stock_requisition_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM stock_requisitions r WHERE r.tenant_id = OLD.tenant_id AND r.id = OLD.requisition_id
                    AND r.number IS NOT NULL) THEN
          IF TG_OP = 'DELETE' OR NEW.product_id IS DISTINCT FROM OLD.product_id
             OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.quantity IS DISTINCT FROM OLD.quantity
             OR NEW.source_location_id IS DISTINCT FROM OLD.source_location_id THEN
            RAISE EXCEPTION 'LINE_RESERVED' USING ERRCODE = '23000';
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER stock_requisition_lines_fixed BEFORE UPDATE OR DELETE ON stock_requisition_lines
      FOR EACH ROW EXECUTE FUNCTION stock_requisition_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('stock_requisition_event_lines')
    this.schema.dropTable('stock_requisition_events')
    this.schema.dropTable('stock_requisition_lines')
    this.schema.dropTable('stock_requisitions')
    this.schema.raw('DROP FUNCTION stock_requisition_lines_fixed()')
    this.schema.raw('DROP FUNCTION stock_requisition_events_fixed()')
  }
}
