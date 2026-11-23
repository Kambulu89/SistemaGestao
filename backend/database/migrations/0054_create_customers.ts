import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Clientes (Prompt 10, bloco 10.1) — módulo `sales`.
 *
 *  - `customer_segments`: segmentos comerciais configuráveis (usados nas tabelas de preços do 10.2).
 *  - `customers`: o papel de cliente de um terceiro (`business_partners`, um por terceiro: o mesmo terceiro pode ser
 *    fornecedor e cliente sem duplicar a ficha) — moeda, prazo de pagamento, limite de crédito, segmento e estado
 *    (activo, bloqueado com motivo, inactivo).
 *  - `customer_addresses`: moradas de facturação e de entrega (uma por omissão de cada tipo).
 *  - `customer_versions`: histórico imutável da identidade fiscal e da morada de facturação usadas nos documentos — cada
 *    alteração gera uma versão nova; os documentos de venda guardam a versão que usaram.
 *  - `customer_events`: histórico (só de acréscimo).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'customer_segments', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.string('description', 500).nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'customer_segments_code_unique' })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'customer_segments_status_check')
    })

    createTenantTable(this, 'customers', (table) => {
      table.uuid('partner_id').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.integer('payment_terms_days').notNullable().defaultTo(0)
      table.decimal('credit_limit', 20, 2).nullable()
      table.uuid('segment_id').nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.string('status_reason', 500).nullable()
      table.string('notes', 2000).nullable()
      tenantForeignKey(table, 'partner_id', 'business_partners')
      tenantForeignKey(table, 'segment_id', 'customer_segments')
      table.unique(['tenant_id', 'partner_id'], { indexName: 'customers_partner_unique' })
      table.check(`status IN ('ACTIVE','BLOCKED','INACTIVE')`, [], 'customers_status_check')
      table.check(
        `payment_terms_days BETWEEN 0 AND 365 AND (credit_limit IS NULL OR credit_limit >= 0)
         AND (status = 'ACTIVE' OR status_reason IS NOT NULL)`,
        [],
        'customers_values_check'
      )
    })

    createTenantTable(this, 'customer_addresses', (table) => {
      table.uuid('customer_id').notNullable()
      table.string('kind', 10).notNullable()
      table.string('label', 80).notNullable()
      table.string('address_line', 200).notNullable()
      table.string('city', 100).nullable()
      table.string('municipality', 100).nullable()
      table.string('province', 100).nullable()
      table.string('postal_code', 20).nullable()
      table.specificType('country_code', 'char(2)').notNullable()
      table.boolean('is_default').notNullable().defaultTo(false)
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'customer_id', 'customers')
      table.index(['tenant_id', 'customer_id'], 'customer_addresses_customer_index')
      table.check(`kind IN ('BILLING','DELIVERY')`, [], 'customer_addresses_kind_check')
      table.check(
        `status IN ('ACTIVE','INACTIVE') AND (status = 'ACTIVE' OR NOT is_default)`,
        [],
        'customer_addresses_status_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX customer_addresses_default_unique ON customer_addresses
      (tenant_id, customer_id, kind) WHERE is_default`)

    createTenantTable(this, 'customer_versions', (table) => {
      table.uuid('customer_id').notNullable()
      table.integer('version_no').notNullable()
      table.jsonb('data').notNullable()
      table.string('hash', 64).notNullable()
      tenantForeignKey(table, 'customer_id', 'customers')
      table.unique(['tenant_id', 'customer_id', 'version_no'], {
        indexName: 'customer_versions_no_unique',
      })
      table.check('version_no >= 1', [], 'customer_versions_no_check')
    })

    createTenantTable(this, 'customer_events', (table) => {
      table.uuid('customer_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('from_status', 10).nullable()
      table.string('to_status', 10).nullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'customer_id', 'customers')
      table.index(['tenant_id', 'customer_id'], 'customer_events_customer_index')
    })

    for (const t of ['customer_versions', 'customer_events']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }
    // O cliente não muda de terceiro e nunca se apaga (é referido pelos documentos).
    this.schema.raw(`
      CREATE FUNCTION customers_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.partner_id IS DISTINCT FROM OLD.partner_id THEN
          RAISE EXCEPTION 'CUSTOMER_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER customers_fixed BEFORE UPDATE OR DELETE
      ON customers FOR EACH ROW EXECUTE FUNCTION customers_fixed()`)
  }

  async down() {
    this.schema.dropTable('customer_events')
    this.schema.dropTable('customer_versions')
    this.schema.dropTable('customer_addresses')
    this.schema.dropTable('customers')
    this.schema.dropTable('customer_segments')
    for (const f of ['customer_versions_fixed', 'customer_events_fixed', 'customers_fixed'])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
