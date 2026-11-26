import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Cobranças (Prompt 10, bloco 10.10) — módulo `sales`, até existir o módulo Finanças (Prompt 11), que será o dono das
 * contas a receber: aqui só há o contrato de leitura (`customerReceivables`) calculado dos documentos e o registo da
 * actividade de cobrança.
 *
 *  - `collection_promises`: promessa de pagamento (valor, data, facturas a que se refere). Uma promessa NUNCA é um
 *    pagamento: não altera saldos; o estado cumprida/falhada calcula-se dos recebimentos confirmados.
 *  - `collection_activities`: contactos de cobrança (chamada, email, visita, carta, nota) com o resultado e a próxima
 *    acção — só de acréscimo.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'collection_promises', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('amount', 20, 2).notNullable()
      table.date('promised_date').notNullable()
      table.specificType('invoice_ids', 'uuid[]').notNullable().defaultTo('{}')
      table.string('contact_name', 120).nullable()
      table.string('notes', 500).nullable()
      table.boolean('cancelled').notNullable().defaultTo(false)
      table.string('cancel_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'customer_id', 'customers')
      table.index(
        ['tenant_id', 'customer_id', 'legal_entity_id'],
        'collection_promises_customer_index'
      )
      table.check(
        `amount > 0 AND (NOT cancelled OR cancel_reason IS NOT NULL)`,
        [],
        'collection_promises_values_check'
      )
    })

    createTenantTable(this, 'collection_activities', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.string('kind', 10).notNullable()
      table.string('contact_name', 120).nullable()
      table.string('outcome', 20).notNullable()
      table.string('notes', 1000).notNullable()
      table.date('next_action_date').nullable()
      table.uuid('promise_id').nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'promise_id', 'collection_promises')
      table.index(
        ['tenant_id', 'customer_id', 'legal_entity_id'],
        'collection_activities_customer_index'
      )
      table.check(
        `kind IN ('CALL','EMAIL','VISIT','LETTER','NOTE')
         AND outcome IN ('REACHED','NO_ANSWER','PROMISED','DISPUTED','PAID_CLAIMED','OTHER')
         AND length(notes) >= 3`,
        [],
        'collection_activities_values_check'
      )
    })

    // A promessa só muda para anulada (com motivo); o resto é fixo. Os contactos são só de acréscimo.
    this.schema.raw(`
      CREATE FUNCTION collection_promises_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.cancelled
           OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.promised_date IS DISTINCT FROM OLD.promised_date
           OR NEW.invoice_ids IS DISTINCT FROM OLD.invoice_ids OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
           OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'PROMISE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER collection_promises_fixed BEFORE UPDATE OR DELETE
      ON collection_promises FOR EACH ROW EXECUTE FUNCTION collection_promises_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION collection_activities_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER collection_activities_fixed BEFORE UPDATE OR DELETE
      ON collection_activities FOR EACH ROW EXECUTE FUNCTION collection_activities_fixed()`)
  }

  async down() {
    this.schema.dropTable('collection_activities')
    this.schema.dropTable('collection_promises')
    this.schema.raw(`DROP FUNCTION collection_activities_fixed()`)
    this.schema.raw(`DROP FUNCTION collection_promises_fixed()`)
  }
}
