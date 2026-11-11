import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Integrações do inventário (Prompt 08, bloco 8.10).
 *
 *  - `inventory_accounting_events`: o que o inventário envia ao motor de contabilização — um evento por lançamento de
 *    stock (ou ajuste de custo), entidade legal e sentido, com os montantes por classe contabilística. O conteúdo é fixo
 *    (gatilho); só o estado muda (pendente → lançado/rascunho, ou falhado e repetido). Idempotente pela chave.
 *  - `inventory_integration_events`: cada pedido de Compras/Vendas (ou de um sistema externo) — recepção de compra,
 *    reserva, libertação, entrega e devolução de venda — com a chave de idempotência, o resumo do pedido e as
 *    referências (encomenda, guia, recepção) e o lançamento de stock que produziu. Só acréscimo.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'inventory_accounting_events', (table) => {
      table.uuid('posting_id').nullable()
      table.uuid('adjustment_id').nullable()
      table.uuid('legal_entity_id').notNullable()
      table.string('direction', 3).notNullable()
      table.string('event', 40).notNullable()
      table.string('source_ref', 120).notNullable()
      table.date('occurred_on').notNullable()
      table.decimal('total', 20, 2).notNullable()
      table.jsonb('amounts').notNullable()
      table.uuid('cost_center_id').nullable()
      table.string('idempotency_key', 120).notNullable()
      table.string('status', 10).notNullable().defaultTo('PENDING')
      table.uuid('posting_event_id').nullable()
      table.string('error', 500).nullable()
      table.integer('attempts').notNullable().defaultTo(0)
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      tenantForeignKey(table, 'adjustment_id', 'stock_cost_adjustments')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'posting_event_id', 'posting_events')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      table.unique(['tenant_id', 'idempotency_key'], {
        indexName: 'inventory_accounting_events_key_unique',
      })
      table.index(['tenant_id', 'status'], 'inventory_accounting_events_status_index')
      table.index(['tenant_id', 'posting_id'], 'inventory_accounting_events_posting_index')
      table.check(`direction IN ('IN','OUT')`, [], 'inventory_accounting_events_direction_check')
      table.check(
        `status IN ('PENDING','POSTED','DRAFTED','FAILED')`,
        [],
        'inventory_accounting_events_status_check'
      )
      table.check('total > 0', [], 'inventory_accounting_events_total_check')
      table.check(
        '(posting_id IS NULL) <> (adjustment_id IS NULL)',
        [],
        'inventory_accounting_events_origin_check'
      )
      table.check(
        `(status IN ('POSTED','DRAFTED')) = (posting_event_id IS NOT NULL)`,
        [],
        'inventory_accounting_events_posted_check'
      )
    })
    // O que se contabiliza não muda depois de criado; um evento lançado não volta atrás.
    this.schema.raw(`
      CREATE FUNCTION inventory_accounting_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.event IS DISTINCT FROM OLD.event OR NEW.amounts IS DISTINCT FROM OLD.amounts
           OR NEW.total IS DISTINCT FROM OLD.total OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
           OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.occurred_on IS DISTINCT FROM OLD.occurred_on
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR (OLD.status IN ('POSTED','DRAFTED') AND NEW.status IS DISTINCT FROM OLD.status) THEN
          RAISE EXCEPTION 'ACCOUNTING_EVENT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER inventory_accounting_events_fixed BEFORE UPDATE OR DELETE
      ON inventory_accounting_events FOR EACH ROW EXECUTE FUNCTION inventory_accounting_events_fixed()`)

    createTenantTable(this, 'inventory_integration_events', (table) => {
      table.string('kind', 20).notNullable()
      table.string('source_module', 20).notNullable()
      table.uuid('warehouse_id').notNullable()
      table.uuid('legal_entity_id').notNullable()
      table.string('order_ref', 80).notNullable()
      table.string('document_ref', 80).nullable()
      table.string('counterparty_ref', 80).nullable()
      table.string('idempotency_key', 100).notNullable()
      table.string('request_hash', 64).notNullable()
      table.uuid('posting_id').nullable()
      table.jsonb('summary').notNullable()
      tenantForeignKey(table, 'warehouse_id', 'warehouses')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'posting_id', 'stock_postings')
      table.unique(['tenant_id', 'idempotency_key'], {
        indexName: 'inventory_integration_events_key_unique',
      })
      table.index(['tenant_id', 'kind', 'order_ref'], 'inventory_integration_events_order_index')
      table.check(
        `kind IN ('PURCHASE_RECEIPT','SALE_RESERVATION','SALE_RELEASE','SALE_DELIVERY','SALE_RETURN')`,
        [],
        'inventory_integration_events_kind_check'
      )
    })
    this.schema.raw(`
      CREATE FUNCTION inventory_integration_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'INTEGRATION_EVENT_FIXED' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER inventory_integration_events_fixed BEFORE UPDATE OR DELETE
      ON inventory_integration_events FOR EACH ROW EXECUTE FUNCTION inventory_integration_events_fixed()`)
  }

  async down() {
    this.schema.dropTable('inventory_integration_events')
    this.schema.dropTable('inventory_accounting_events')
    this.schema.raw('DROP FUNCTION inventory_integration_events_fixed()')
    this.schema.raw('DROP FUNCTION inventory_accounting_events_fixed()')
  }
}
