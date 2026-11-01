import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Expedições (M04). Uma expedição entrega parte (ou a totalidade) de uma encomenda confirmada: nasce em rascunho, é
 * **lançada** (aí recebe número e baixa o stock) e só se desfaz por **reversão** explícita; nunca se altera nem se apaga
 * depois de lançada (nem por SQL directo). As linhas apontam para as linhas da encomenda; a soma lançada de uma linha
 * nunca ultrapassa o que foi encomendado (verificado sob bloqueio da encomenda, na aplicação).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'shipments', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('order_id').notNullable()
      table.string('number', 60).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('notes', 1000).nullable()
      table.timestamp('shipped_at', { useTz: true }).nullable()
      table.timestamp('reversed_at', { useTz: true }).nullable()
      table.string('reverse_reason', 300).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'order_id', 'sales_orders')
      table.index(['tenant_id', 'order_id'], 'shipments_order_index')
      table.index(['tenant_id', 'status'], 'shipments_status_index')
    })
    this.schema.raw(`
      ALTER TABLE shipments
        ADD CONSTRAINT shipments_status_check CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
        ADD CONSTRAINT shipments_number_check CHECK (status = 'DRAFT' OR number IS NOT NULL),
        ADD CONSTRAINT shipments_posted_check CHECK (status = 'DRAFT' OR shipped_at IS NOT NULL),
        ADD CONSTRAINT shipments_reversed_check
          CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reverse_reason IS NOT NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX shipments_number_unique ON shipments (tenant_id, number) WHERE number IS NOT NULL
    `)

    createTenantTable(this, 'shipment_lines', (table) => {
      table.uuid('shipment_id').notNullable()
      table.uuid('order_line_id').notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      tenantForeignKey(table, 'shipment_id', 'shipments')
      tenantForeignKey(table, 'order_line_id', 'sales_lines')
      table.unique(['tenant_id', 'shipment_id', 'order_line_id'], {
        indexName: 'shipment_lines_unique',
      })
      table.index(['tenant_id', 'order_line_id'], 'shipment_lines_order_line_index')
    })
    this.schema.raw(`
      ALTER TABLE shipment_lines ADD CONSTRAINT shipment_lines_quantity_check CHECK (quantity > 0)
    `)

    // Só o rascunho se edita ou apaga; lançada, só passa a revertida (o resto fica como estava).
    this.schema.raw(`
      CREATE FUNCTION shipments_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'SHIPMENT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
        IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
           AND (NEW.tenant_id, NEW.organization_id, NEW.order_id, NEW.number, NEW.shipped_at, NEW.notes)
               IS NOT DISTINCT FROM
               (OLD.tenant_id, OLD.organization_id, OLD.order_id, OLD.number, OLD.shipped_at, OLD.notes) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'SHIPMENT_IMMUTABLE' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER shipments_guard BEFORE UPDATE OR DELETE ON shipments
        FOR EACH ROW EXECUTE FUNCTION shipments_guard()
    `)
    this.schema.raw(`
      CREATE FUNCTION shipment_lines_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        parent_status text;
        row_ record;
      BEGIN
        IF TG_OP = 'DELETE' THEN row_ := OLD; ELSE row_ := NEW; END IF;
        IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        SELECT status INTO parent_status FROM shipments WHERE tenant_id = row_.tenant_id AND id = row_.shipment_id;
        IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
          RAISE EXCEPTION 'SHIPMENT_LINES_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER shipment_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON shipment_lines
        FOR EACH ROW EXECUTE FUNCTION shipment_lines_guard()
    `)

    auditTable(this, 'shipments')
    auditTable(this, 'shipment_lines')
  }

  async down() {
    dropTable(this, 'shipment_lines')
    dropTable(this, 'shipments')
    this.schema.raw('DROP FUNCTION IF EXISTS shipment_lines_guard()')
    this.schema.raw('DROP FUNCTION IF EXISTS shipments_guard()')
  }
}
