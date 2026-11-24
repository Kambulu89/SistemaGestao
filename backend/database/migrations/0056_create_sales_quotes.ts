import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Orçamentos e propostas (Prompt 10, bloco 10.3) — módulo `sales`.
 *
 *  - `sales_quotes`: cabeçalho (entidade legal, cliente, comercial, data, validade, moeda, prazo de pagamento), totais
 *    exactos, estado, versão em curso e número (atribuído no primeiro envio, por série documental `SALES_QUOTE`).
 *    O conteúdo só muda em rascunho; depois só os campos do ciclo. Aceite, fica fixo; a conversão em encomenda é única
 *    (`converted_order_id`, índice único) e só a partir de aceite.
 *  - `sales_quote_lines`: produto/variante, quantidade, desconto ou preço manual pedidos, imposto por linha e o
 *    resultado do motor de preços (snapshot e valores). Só mudam com o orçamento em rascunho.
 *  - `sales_quote_versions`: a fotografia imutável de cada versão enviada ao cliente (cabeçalho, versão dos dados do
 *    cliente, linhas, totais e impressão digital). A aceitação refere-se a uma versão enviada.
 *  - `sales_quote_events`: cronologia (só de acréscimo).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'sales_quotes', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('customer_id').notNullable()
      table.uuid('salesperson_membership_id').notNullable()
      table.uuid('series_id').nullable()
      table.string('number', 60).nullable()
      table.integer('version_no').notNullable().defaultTo(1)
      table.date('quote_date').notNullable()
      table.date('valid_until').notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.integer('payment_terms_days').notNullable().defaultTo(0)
      table.string('customer_reference', 60).nullable()
      table.string('notes', 2000).nullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.decimal('net_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('tax_total', 20, 2).notNullable().defaultTo(0)
      table.decimal('gross_total', 20, 2).notNullable().defaultTo(0)
      table.boolean('requires_approval').notNullable().defaultTo(false)
      table.string('pricing_hash', 64).nullable()
      table.uuid('submitted_by').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.timestamp('sent_at', { useTz: true }).nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.string('decided_by_name', 120).nullable()
      table.string('decision_reason', 500).nullable()
      table.uuid('converted_order_id').nullable()
      table.timestamp('converted_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'salesperson_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.index(['tenant_id', 'legal_entity_id', 'status'], 'sales_quotes_entity_index')
      table.index(['tenant_id', 'customer_id'], 'sales_quotes_customer_index')
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','ACCEPTED','DECLINED','CANCELLED','CONVERTED')`,
        [],
        'sales_quotes_status_check'
      )
      table.check(
        `valid_until >= quote_date AND version_no >= 1 AND payment_terms_days BETWEEN 0 AND 365
         AND net_total >= 0 AND tax_total >= 0 AND gross_total = net_total + tax_total
         AND (number IS NULL) = (series_id IS NULL)
         AND (status NOT IN ('SENT','ACCEPTED','DECLINED','CONVERTED') OR number IS NOT NULL)
         AND (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by OR NOT requires_approval)
         AND ((status = 'CONVERTED') = (converted_order_id IS NOT NULL))`,
        [],
        'sales_quotes_values_check'
      )
    })
    this.schema
      .raw(`CREATE UNIQUE INDEX sales_quotes_number_unique ON sales_quotes (tenant_id, series_id, number)
      WHERE number IS NOT NULL`)
    this.schema
      .raw(`CREATE UNIQUE INDEX sales_quotes_order_unique ON sales_quotes (tenant_id, converted_order_id)
      WHERE converted_order_id IS NOT NULL`)

    createTenantTable(this, 'sales_quote_lines', (table) => {
      table.uuid('quote_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.string('description', 300).notNullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('manual_discount_pct', 5, 2).nullable()
      table.decimal('manual_unit_price', 20, 4).nullable()
      table.decimal('tax_rate', 5, 2).notNullable()
      table.string('tax_exemption_reason', 300).nullable()
      table.string('price_source', 10).notNullable()
      table.decimal('base_price', 20, 4).nullable()
      table.decimal('net_unit_price', 20, 4).nullable()
      table.decimal('net_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('tax_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('gross_amount', 20, 2).notNullable().defaultTo(0)
      table.boolean('requires_approval').notNullable().defaultTo(false)
      table.jsonb('pricing').notNullable()
      tenantForeignKey(table, 'quote_id', 'sales_quotes')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.unique(['tenant_id', 'quote_id', 'line_no'], {
        indexName: 'sales_quote_lines_no_unique',
      })
      table.check(
        `quantity > 0 AND tax_rate BETWEEN 0 AND 100
         AND (tax_rate > 0 OR tax_exemption_reason IS NOT NULL)
         AND NOT (manual_discount_pct IS NOT NULL AND manual_unit_price IS NOT NULL)
         AND (manual_discount_pct IS NULL OR manual_discount_pct BETWEEN 0 AND 100)
         AND (manual_unit_price IS NULL OR manual_unit_price >= 0)
         AND price_source IN ('LIST','CATALOG','MANUAL','NONE')
         AND net_amount >= 0 AND tax_amount >= 0 AND gross_amount = net_amount + tax_amount`,
        [],
        'sales_quote_lines_values_check'
      )
    })

    createTenantTable(this, 'sales_quote_versions', (table) => {
      table.uuid('quote_id').notNullable()
      table.integer('version_no').notNullable()
      table.uuid('customer_version_id').notNullable()
      table.jsonb('data').notNullable()
      table.string('hash', 64).notNullable()
      table.string('sent_channel', 10).notNullable()
      table.string('sent_to', 200).nullable()
      tenantForeignKey(table, 'quote_id', 'sales_quotes')
      tenantForeignKey(table, 'customer_version_id', 'customer_versions')
      table.unique(['tenant_id', 'quote_id', 'version_no'], {
        indexName: 'sales_quote_versions_no_unique',
      })
      table.check(
        `sent_channel IN ('EMAIL','HAND','PORTAL','OTHER')`,
        [],
        'sales_quote_versions_channel_check'
      )
    })

    createTenantTable(this, 'sales_quote_events', (table) => {
      table.uuid('quote_id').notNullable()
      table.string('kind', 30).notNullable()
      table.integer('version_no').notNullable()
      table.string('from_status', 20).nullable()
      table.string('to_status', 20).nullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'quote_id', 'sales_quotes')
      table.index(['tenant_id', 'quote_id'], 'sales_quote_events_quote_index')
    })

    for (const t of ['sales_quote_versions', 'sales_quote_events']) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Conteúdo do cabeçalho só em rascunho; aceite/recusado/anulado/convertido são finais (excepto aceite → convertido);
    // a conversão nunca se desfaz; nunca se apaga.
    const content = [
      'legal_entity_id',
      'customer_id',
      'salesperson_membership_id',
      'quote_date',
      'valid_until',
      'currency',
      'payment_terms_days',
      'customer_reference',
      'notes',
      'net_total',
      'tax_total',
      'gross_total',
      'requires_approval',
      'pricing_hash',
    ]
      .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
      .join(' OR ')
    this.schema.raw(`
      CREATE FUNCTION sales_quotes_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'DRAFT' AND (${content}) THEN
          RAISE EXCEPTION 'QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.number IS NOT NULL AND (NEW.number IS DISTINCT FROM OLD.number OR NEW.series_id IS DISTINCT FROM OLD.series_id) THEN
          RAISE EXCEPTION 'QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status IN ('DECLINED','CANCELLED','CONVERTED') AND NEW.status IS DISTINCT FROM OLD.status
           AND NOT (OLD.status = 'DECLINED' AND NEW.status = 'DRAFT') THEN
          RAISE EXCEPTION 'QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'ACCEPTED' AND NEW.status NOT IN ('ACCEPTED','CONVERTED') THEN
          RAISE EXCEPTION 'QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.converted_order_id IS NOT NULL AND NEW.converted_order_id IS DISTINCT FROM OLD.converted_order_id THEN
          RAISE EXCEPTION 'QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_quotes_fixed BEFORE UPDATE OR DELETE
      ON sales_quotes FOR EACH ROW EXECUTE FUNCTION sales_quotes_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION sales_quote_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM sales_quotes
         WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.quote_id, OLD.quote_id);
        IF s IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.quote_id IS DISTINCT FROM OLD.quote_id THEN
          RAISE EXCEPTION 'QUOTE_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema.raw(`CREATE TRIGGER sales_quote_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON sales_quote_lines FOR EACH ROW EXECUTE FUNCTION sales_quote_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('sales_quote_events')
    this.schema.dropTable('sales_quote_versions')
    this.schema.dropTable('sales_quote_lines')
    this.schema.dropTable('sales_quotes')
    for (const f of [
      'sales_quote_versions_fixed',
      'sales_quote_events_fixed',
      'sales_quotes_fixed',
      'sales_quote_lines_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
