import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Logística de stock (M08): transferências entre armazéns (com «em trânsito»), contagens físicas (com congelamento por local)
 * e devoluções. Nenhuma altera saldos: todos os efeitos são movimentos do livro (M07), com origem única. Os documentos
 * deixam de se alterar quando avançam de estado (triggers, também para a conta dona); as recepções de transferências são
 * só-de-acrescentar.
 */
export default class extends BaseSchema {
  async up() {
    // Armazéns técnicos (trânsito, danificado, quarentena): existem por organização mas nunca são o armazém de vendas.
    this.schema.raw(`
      ALTER TABLE warehouses
        ADD COLUMN technical boolean NOT NULL DEFAULT false,
        ADD CONSTRAINT warehouses_technical_check CHECK (NOT (technical AND sales_default))
    `)

    // --- transferências ------------------------------------------------------------------------
    createTenantTable(this, 'stock_transfers', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('number', 50).nullable()
      table.uuid('source_warehouse_id').notNullable()
      table.uuid('destination_warehouse_id').notNullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.string('notes', 1000).nullable()
      table.timestamp('dispatched_at', { useTz: true }).nullable()
      table.timestamp('cancelled_at', { useTz: true }).nullable()
      table.string('cancel_reason', 300).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'source_warehouse_id', 'warehouses')
      tenantForeignKey(table, 'destination_warehouse_id', 'warehouses')
      table.index(['tenant_id', 'status'], 'stock_transfers_status_index')
    })
    this.schema.raw(`
      ALTER TABLE stock_transfers
        ADD CONSTRAINT stock_transfers_status_check
          CHECK (status IN ('DRAFT', 'DISPATCHED', 'PARTIAL_RECEIVED', 'RECEIVED', 'CANCELLED')),
        ADD CONSTRAINT stock_transfers_warehouses_check CHECK (source_warehouse_id <> destination_warehouse_id),
        ADD CONSTRAINT stock_transfers_number_check
          CHECK ((status IN ('DRAFT', 'CANCELLED')) = (number IS NULL)),
        ADD CONSTRAINT stock_transfers_cancel_check
          CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX stock_transfers_number_unique ON stock_transfers (tenant_id, organization_id, number)
        WHERE number IS NOT NULL
    `)
    createTenantTable(this, 'transfer_lines', (table) => {
      table.uuid('transfer_id').notNullable()
      table.integer('position').notNullable()
      table.uuid('variant_id').notNullable()
      table.uuid('lot_id').nullable()
      table.uuid('source_location_id').notNullable()
      table.uuid('destination_location_id').notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.decimal('dispatched_qty', 19, 6).notNullable().defaultTo(0)
      table.decimal('received_qty', 19, 6).notNullable().defaultTo(0)
      tenantForeignKey(table, 'transfer_id', 'stock_transfers')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'lot_id', 'lots')
      tenantForeignKey(table, 'source_location_id', 'stock_locations')
      tenantForeignKey(table, 'destination_location_id', 'stock_locations')
      table.unique(['tenant_id', 'transfer_id', 'position'], {
        indexName: 'transfer_lines_position_unique',
      })
    })
    this.schema.raw(`
      ALTER TABLE transfer_lines
        ADD CONSTRAINT transfer_lines_quantity_check CHECK (quantity > 0),
        ADD CONSTRAINT transfer_lines_dispatched_check CHECK (dispatched_qty = 0 OR dispatched_qty = quantity),
        ADD CONSTRAINT transfer_lines_received_check CHECK (received_qty >= 0 AND received_qty <= dispatched_qty)
    `)
    createTenantTable(this, 'transfer_receipts', (table) => {
      table.uuid('transfer_id').notNullable()
      table.string('idempotency_key', 100).nullable()
      table.timestamp('received_at', { useTz: true }).notNullable().defaultTo(this.now())
      tenantForeignKey(table, 'transfer_id', 'stock_transfers')
    })
    this.schema.raw(`
      CREATE UNIQUE INDEX transfer_receipts_key_unique ON transfer_receipts (tenant_id, transfer_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `)
    createTenantTable(this, 'transfer_receipt_lines', (table) => {
      table.uuid('receipt_id').notNullable()
      table.uuid('transfer_line_id').notNullable()
      table.decimal('quantity', 19, 6).notNullable()
      tenantForeignKey(table, 'receipt_id', 'transfer_receipts')
      tenantForeignKey(table, 'transfer_line_id', 'transfer_lines')
      table.unique(['tenant_id', 'receipt_id', 'transfer_line_id'], {
        indexName: 'transfer_receipt_lines_unique',
      })
    })
    this.schema.raw(
      `ALTER TABLE transfer_receipt_lines ADD CONSTRAINT transfer_receipt_lines_quantity_check CHECK (quantity > 0)`
    )

    // --- contagens -----------------------------------------------------------------------------
    createTenantTable(this, 'stock_counts', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('warehouse_id').notNullable()
      table.string('number', 50).nullable()
      table.string('status', 12).notNullable().defaultTo('DRAFT')
      table.string('freeze_mode', 12).notNullable().defaultTo('LOCATION')
      table.boolean('blind').notNullable().defaultTo(false)
      table.jsonb('location_ids').notNullable().defaultTo('[]')
      table.timestamp('snapshot_at', { useTz: true }).nullable()
      table.timestamp('posted_at', { useTz: true }).nullable()
      table.string('notes', 1000).nullable()
      table.string('cancel_reason', 300).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      table.index(['tenant_id', 'status'], 'stock_counts_status_index')
    })
    this.schema.raw(`
      ALTER TABLE stock_counts
        ADD CONSTRAINT stock_counts_status_check CHECK (status IN ('DRAFT', 'OPEN', 'REVIEW', 'POSTED', 'CANCELLED')),
        ADD CONSTRAINT stock_counts_freeze_check CHECK (freeze_mode = 'LOCATION'),
        ADD CONSTRAINT stock_counts_snapshot_check CHECK ((status IN ('DRAFT', 'CANCELLED')) OR snapshot_at IS NOT NULL),
        ADD CONSTRAINT stock_counts_posted_check CHECK ((status = 'POSTED') = (posted_at IS NOT NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX stock_counts_number_unique ON stock_counts (tenant_id, organization_id, number)
        WHERE number IS NOT NULL
    `)
    createTenantTable(this, 'count_lines', (table) => {
      table.uuid('count_id').notNullable()
      table.uuid('variant_id').notNullable()
      table.uuid('location_id').notNullable()
      table.uuid('lot_id').nullable()
      table.decimal('expected_qty', 19, 6).notNullable().defaultTo(0)
      table.decimal('counted_qty', 19, 6).nullable()
      table.string('reason', 300).nullable()
      tenantForeignKey(table, 'count_id', 'stock_counts')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'location_id', 'stock_locations')
      tenantForeignKey(table, 'lot_id', 'lots')
    })
    this.schema.raw(`
      ALTER TABLE count_lines
        ADD COLUMN variance_qty numeric(19,6) GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
        ADD CONSTRAINT count_lines_expected_check CHECK (expected_qty >= 0),
        ADD CONSTRAINT count_lines_counted_check CHECK (counted_qty IS NULL OR counted_qty >= 0)
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX count_lines_key_unique ON count_lines
        (tenant_id, count_id, variant_id, location_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid))
    `)
    // Congelamento: um local só pertence a uma contagem de cada vez; enquanto está congelado só essa contagem o move.
    this.schema.raw(`ALTER TABLE stock_locations ADD COLUMN frozen_by_count_id uuid`)
    this.schema.raw(`
      ALTER TABLE stock_locations ADD CONSTRAINT stock_locations_frozen_fk
        FOREIGN KEY (tenant_id, frozen_by_count_id) REFERENCES stock_counts (tenant_id, id) ON DELETE RESTRICT
    `)

    // --- devoluções ----------------------------------------------------------------------------
    createTenantTable(this, 'goods_returns', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('number', 50).nullable()
      table.string('direction', 10).notNullable()
      table.uuid('source_document_id').notNullable()
      table.uuid('warehouse_id').notNullable()
      table.string('reason', 300).notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.timestamp('posted_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      table.index(['tenant_id', 'source_document_id'], 'goods_returns_source_index')
    })
    this.schema.raw(`
      ALTER TABLE goods_returns
        ADD CONSTRAINT goods_returns_direction_check CHECK (direction IN ('CUSTOMER', 'SUPPLIER')),
        ADD CONSTRAINT goods_returns_status_check CHECK (status IN ('DRAFT', 'APPROVED', 'POSTED')),
        ADD CONSTRAINT goods_returns_number_check CHECK ((status = 'POSTED') = (number IS NOT NULL)),
        ADD CONSTRAINT goods_returns_posted_check CHECK ((status = 'POSTED') = (posted_at IS NOT NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX goods_returns_number_unique ON goods_returns (tenant_id, organization_id, number)
        WHERE number IS NOT NULL
    `)
    createTenantTable(this, 'return_lines', (table) => {
      table.uuid('return_id').notNullable()
      table.integer('position').notNullable()
      table.uuid('source_line_id').notNullable()
      table.uuid('variant_id').notNullable()
      table.uuid('lot_id').nullable()
      table.uuid('location_id').nullable()
      table.decimal('quantity', 19, 6).notNullable()
      table.string('condition', 10).notNullable().defaultTo('SELLABLE')
      tenantForeignKey(table, 'return_id', 'goods_returns')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'lot_id', 'lots')
      tenantForeignKey(table, 'location_id', 'stock_locations')
      table.unique(['tenant_id', 'return_id', 'position'], {
        indexName: 'return_lines_position_unique',
      })
      table.index(['tenant_id', 'source_line_id'], 'return_lines_source_index')
    })
    this.schema.raw(`
      ALTER TABLE return_lines
        ADD CONSTRAINT return_lines_quantity_check CHECK (quantity > 0),
        ADD CONSTRAINT return_lines_condition_check CHECK (condition IN ('SELLABLE', 'DAMAGED', 'QUARANTINE'))
    `)

    // --- imutabilidade -------------------------------------------------------------------------
    const parentGuard = (
      fn: string,
      parent: string,
      fk: string,
      openStates: string,
      onUpdate = ''
    ) => `
      CREATE FUNCTION ${fn}() RETURNS trigger
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
        SELECT status INTO parent_status FROM ${parent} WHERE tenant_id = row_.tenant_id AND id = row_.${fk};
        IF parent_status IS NULL OR parent_status IN (${openStates}) THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        ${onUpdate}
        RAISE EXCEPTION '${fn.toUpperCase().replace('_GUARD', '_IMMUTABLE')}' USING ERRCODE = '23000';
      END
      $$
    `

    this.schema.raw(`
      CREATE FUNCTION stock_transfers_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'STOCK_TRANSFER_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('RECEIVED', 'CANCELLED') THEN
          RAISE EXCEPTION 'STOCK_TRANSFER_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'DRAFT' AND
           (NEW.tenant_id, NEW.organization_id, NEW.source_warehouse_id, NEW.destination_warehouse_id, NEW.number)
           IS DISTINCT FROM
           (OLD.tenant_id, OLD.organization_id, OLD.source_warehouse_id, OLD.destination_warehouse_id, OLD.number) THEN
          RAISE EXCEPTION 'STOCK_TRANSFER_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'DISPATCHED', 'CANCELLED') THEN
          RAISE EXCEPTION 'STOCK_TRANSFER_TRANSITION' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DISPATCHED' AND NEW.status NOT IN ('DISPATCHED', 'PARTIAL_RECEIVED', 'RECEIVED') THEN
          RAISE EXCEPTION 'STOCK_TRANSFER_TRANSITION' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'PARTIAL_RECEIVED' AND NEW.status NOT IN ('PARTIAL_RECEIVED', 'RECEIVED') THEN
          RAISE EXCEPTION 'STOCK_TRANSFER_TRANSITION' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER stock_transfers_guard BEFORE UPDATE OR DELETE ON stock_transfers
        FOR EACH ROW EXECUTE FUNCTION stock_transfers_guard()
    `)
    // Linhas: livres no rascunho; depois só mudam as quantidades expedida e recebida.
    this.schema.raw(
      parentGuard(
        'transfer_lines_guard',
        'stock_transfers',
        'transfer_id',
        `'DRAFT'`,
        `IF TG_OP = 'UPDATE' AND
              (NEW.tenant_id, NEW.transfer_id, NEW.position, NEW.variant_id, NEW.lot_id, NEW.source_location_id,
               NEW.destination_location_id, NEW.quantity)
              IS NOT DISTINCT FROM
              (OLD.tenant_id, OLD.transfer_id, OLD.position, OLD.variant_id, OLD.lot_id, OLD.source_location_id,
               OLD.destination_location_id, OLD.quantity)
           AND NEW.dispatched_qty >= OLD.dispatched_qty AND NEW.received_qty >= OLD.received_qty THEN
          RETURN NEW;
        END IF;`
      )
    )
    this.schema.raw(`
      CREATE TRIGGER transfer_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON transfer_lines
        FOR EACH ROW EXECUTE FUNCTION transfer_lines_guard()
    `)
    for (const table of ['transfer_receipts', 'transfer_receipt_lines']) {
      this.schema.raw(`
        CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION audit_forbid_change()
      `)
    }

    this.schema.raw(`
      CREATE FUNCTION stock_counts_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'STOCK_COUNT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('POSTED', 'CANCELLED') THEN
          RAISE EXCEPTION 'STOCK_COUNT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'DRAFT' AND
           (NEW.tenant_id, NEW.organization_id, NEW.warehouse_id, NEW.number, NEW.snapshot_at, NEW.blind, NEW.location_ids)
           IS DISTINCT FROM
           (OLD.tenant_id, OLD.organization_id, OLD.warehouse_id, OLD.number, OLD.snapshot_at, OLD.blind, OLD.location_ids) THEN
          RAISE EXCEPTION 'STOCK_COUNT_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER stock_counts_guard BEFORE UPDATE OR DELETE ON stock_counts
        FOR EACH ROW EXECUTE FUNCTION stock_counts_guard()
    `)
    // Linhas da contagem: o esperado nunca muda; com a contagem lançada ou cancelada nada muda.
    this.schema.raw(
      parentGuard(
        'count_lines_guard',
        'stock_counts',
        'count_id',
        `'DRAFT', 'OPEN', 'REVIEW'`,
        ''
      ).replace(
        `IF parent_status IS NULL OR parent_status IN ('DRAFT', 'OPEN', 'REVIEW') THEN`,
        `IF TG_OP = 'UPDATE' AND NEW.expected_qty IS DISTINCT FROM OLD.expected_qty THEN
          RAISE EXCEPTION 'COUNT_LINES_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF parent_status IS NULL OR parent_status IN ('DRAFT', 'OPEN', 'REVIEW') THEN`
      )
    )
    this.schema.raw(`
      CREATE TRIGGER count_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON count_lines
        FOR EACH ROW EXECUTE FUNCTION count_lines_guard()
    `)

    this.schema.raw(`
      CREATE FUNCTION goods_returns_guard() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status = 'DRAFT' OR (audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on') THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'GOODS_RETURN_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'POSTED' THEN
          RAISE EXCEPTION 'GOODS_RETURN_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'APPROVED' AND
           (NEW.tenant_id, NEW.organization_id, NEW.direction, NEW.source_document_id, NEW.warehouse_id, NEW.reason)
           IS DISTINCT FROM
           (OLD.tenant_id, OLD.organization_id, OLD.direction, OLD.source_document_id, OLD.warehouse_id, OLD.reason) THEN
          RAISE EXCEPTION 'GOODS_RETURN_IMMUTABLE' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER goods_returns_guard BEFORE UPDATE OR DELETE ON goods_returns
        FOR EACH ROW EXECUTE FUNCTION goods_returns_guard()
    `)
    this.schema.raw(parentGuard('return_lines_guard', 'goods_returns', 'return_id', `'DRAFT'`))
    this.schema.raw(`
      CREATE TRIGGER return_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON return_lines
        FOR EACH ROW EXECUTE FUNCTION return_lines_guard()
    `)

    for (const table of [
      'stock_transfers',
      'transfer_lines',
      'transfer_receipts',
      'transfer_receipt_lines',
      'stock_counts',
      'count_lines',
      'goods_returns',
      'return_lines',
    ]) {
      auditTable(this, table)
    }
  }

  async down() {
    this.schema.raw(`ALTER TABLE stock_locations DROP CONSTRAINT stock_locations_frozen_fk`)
    this.schema.raw(`ALTER TABLE stock_locations DROP COLUMN frozen_by_count_id`)
    for (const table of [
      'return_lines',
      'goods_returns',
      'count_lines',
      'stock_counts',
      'transfer_receipt_lines',
      'transfer_receipts',
      'transfer_lines',
      'stock_transfers',
    ]) {
      dropTable(this, table)
    }
    for (const fn of [
      'return_lines_guard',
      'goods_returns_guard',
      'count_lines_guard',
      'stock_counts_guard',
      'transfer_lines_guard',
      'stock_transfers_guard',
    ]) {
      this.schema.raw(`DROP FUNCTION IF EXISTS ${fn}()`)
    }
    this.schema.raw(`ALTER TABLE warehouses DROP CONSTRAINT warehouses_technical_check`)
    this.schema.raw(`ALTER TABLE warehouses DROP COLUMN technical`)
  }
}
