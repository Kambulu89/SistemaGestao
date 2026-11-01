import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Compras (Prompt 09, bloco 9.1): o fornecedor existente (M06, condições de compra sobre a Party) passa a ter categoria,
 * classificação (o que fornece, criticidade, avaliação) e **homologação** com histórico — sem criar um segundo
 * «fornecedor». Migração só aditiva: os fornecedores actuais ficam `PENDING`, não críticos, e continuam a poder receber
 * encomendas (só a homologação recusada ou suspensa, ou a falta dela num fornecedor crítico, bloqueia).
 *
 *  - `status` (ACTIVE/BLOCKED/INACTIVE) continua a ser o estado comercial; `approval_status` é a homologação.
 *  - `EXPIRED` não se grava: deriva-se de `approval_valid_until` já passado num fornecedor homologado.
 *  - O histórico de homologação é só-de-acrescentar (nem SQL directo o altera).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'supplier_categories', (table) => {
      table.string('code', 50).notNullable()
      table.string('name', 160).notNullable()
      table.text('description').nullable()
      table.boolean('active').notNullable().defaultTo(true)
      table.unique(['tenant_id', 'code'], { indexName: 'supplier_categories_code_unique' })
    })
    auditTable(this, 'supplier_categories')

    this.schema.raw(`
      ALTER TABLE suppliers
        ADD COLUMN category_id uuid NULL,
        ADD COLUMN supply_type text NOT NULL DEFAULT 'GOODS',
        ADD COLUMN critical boolean NOT NULL DEFAULT false,
        ADD COLUMN rating char(1) NULL,
        ADD COLUMN lead_time_days integer NULL,
        ADD COLUMN notes varchar(1000) NULL,
        ADD COLUMN approval_status text NOT NULL DEFAULT 'PENDING',
        ADD COLUMN approval_valid_until date NULL,
        ADD COLUMN approval_conditions varchar(1000) NULL,
        ADD COLUMN approval_requested_by_membership_id uuid NULL,
        ADD CONSTRAINT category_id_tenant_fk FOREIGN KEY (tenant_id, category_id)
          REFERENCES supplier_categories (tenant_id, id) ON DELETE RESTRICT,
        ADD CONSTRAINT approval_requested_by_membership_id_tenant_fk
          FOREIGN KEY (tenant_id, approval_requested_by_membership_id)
          REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
        ADD CONSTRAINT suppliers_supply_type_check CHECK (supply_type IN ('GOODS', 'SERVICES', 'BOTH')),
        ADD CONSTRAINT suppliers_rating_check CHECK (rating IS NULL OR rating IN ('A', 'B', 'C', 'D')),
        ADD CONSTRAINT suppliers_lead_time_check CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650),
        ADD CONSTRAINT suppliers_approval_status_check CHECK (approval_status IN
          ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'CONDITIONALLY_APPROVED', 'REJECTED', 'SUSPENDED')),
        ADD CONSTRAINT suppliers_approval_conditions_check CHECK (
          (approval_status = 'CONDITIONALLY_APPROVED') = (approval_conditions IS NOT NULL)),
        ADD CONSTRAINT suppliers_approval_validity_check CHECK (
          approval_valid_until IS NULL OR approval_status IN ('APPROVED', 'CONDITIONALLY_APPROVED', 'SUSPENDED'))
    `)
    this.schema.raw(`CREATE INDEX suppliers_category_index ON suppliers (tenant_id, category_id)`)
    this.schema.raw(
      `CREATE INDEX suppliers_approval_index ON suppliers (tenant_id, approval_status, approval_valid_until)`
    )

    createTenantTable(this, 'supplier_approval_events', (table) => {
      table.uuid('supplier_id').notNullable()
      table.string('action', 24).notNullable()
      table.string('from_status', 24).notNullable()
      table.string('to_status', 24).notNullable()
      table.string('reason', 500).nullable()
      table.string('conditions', 1000).nullable()
      table.date('valid_until').nullable()
      table.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(this.now())
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      table.index(['tenant_id', 'supplier_id', 'occurred_at'], 'supplier_approval_events_index')
    })
    this.schema.raw(`
      ALTER TABLE supplier_approval_events
        ADD CONSTRAINT supplier_approval_events_action_check CHECK (action IN
          ('SUBMIT', 'APPROVE', 'APPROVE_CONDITIONALLY', 'REJECT', 'SUSPEND'))
    `)
    this.schema.raw(`
      CREATE FUNCTION supplier_approval_events_append_only() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND audit_is_owner_session() AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'SUPPLIER_APPROVAL_HISTORY_APPEND_ONLY' USING ERRCODE = '23000';
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER supplier_approval_events_append_only BEFORE UPDATE OR DELETE ON supplier_approval_events
        FOR EACH ROW EXECUTE FUNCTION supplier_approval_events_append_only()
    `)
  }

  async down() {
    dropTable(this, 'supplier_approval_events')
    this.schema.raw(`DROP FUNCTION supplier_approval_events_append_only()`)
    this.schema.raw(`DROP INDEX suppliers_approval_index`)
    this.schema.raw(`DROP INDEX suppliers_category_index`)
    this.schema.raw(`
      ALTER TABLE suppliers
        DROP CONSTRAINT suppliers_approval_validity_check,
        DROP CONSTRAINT suppliers_approval_conditions_check,
        DROP CONSTRAINT suppliers_approval_status_check,
        DROP CONSTRAINT suppliers_lead_time_check,
        DROP CONSTRAINT suppliers_rating_check,
        DROP CONSTRAINT suppliers_supply_type_check,
        DROP CONSTRAINT approval_requested_by_membership_id_tenant_fk,
        DROP CONSTRAINT category_id_tenant_fk,
        DROP COLUMN approval_requested_by_membership_id, DROP COLUMN approval_conditions,
        DROP COLUMN approval_valid_until, DROP COLUMN approval_status, DROP COLUMN notes,
        DROP COLUMN lead_time_days, DROP COLUMN rating, DROP COLUMN critical, DROP COLUMN supply_type,
        DROP COLUMN category_id
    `)
    dropTable(this, 'supplier_categories')
  }
}
