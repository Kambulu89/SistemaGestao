import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Preços e descontos (Prompt 10, bloco 10.2) — módulo `sales`.
 *
 *  - `price_lists`: tabela de preços geral, de um segmento ou de um cliente; moeda, entidade legal (ou todas), período
 *    e prioridade. Só se edita em rascunho; fica activa com a aprovação de outra pessoa e depois não muda (para mudar
 *    preços copia-se para uma tabela nova). Pode ser inactivada com motivo.
 *  - `price_list_lines`: preço por produto (ou variante) e escalão de quantidade mínima, com limite de desconto próprio
 *    opcional. Só se alteram enquanto a tabela está em rascunho (gatilho).
 *  - `discount_rules`: descontos automáticos (percentagem) para todos, um segmento ou um cliente, de um produto, de uma
 *    categoria ou gerais, a partir de uma quantidade, num período, com prioridade; mesmo ciclo de aprovação.
 *  - `discount_limits`: desconto manual máximo sem aprovação (geral, por segmento ou por cliente).
 *  - `pricing_events`: cronologia (só de acréscimo).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'price_lists', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.string('target_type', 10).notNullable()
      table.uuid('segment_id').nullable()
      table.uuid('customer_id').nullable()
      table.uuid('legal_entity_id').nullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.integer('priority').notNullable().defaultTo(100)
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('notes', 1000).nullable()
      table.uuid('copied_from_id').nullable()
      table.uuid('submitted_by').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.string('inactive_reason', 500).nullable()
      tenantForeignKey(table, 'segment_id', 'customer_segments')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'code'], { indexName: 'price_lists_code_unique' })
      table.check(
        `status IN ('DRAFT','PENDING','ACTIVE','INACTIVE')`,
        [],
        'price_lists_status_check'
      )
      table.check(
        `(target_type = 'GENERAL' AND segment_id IS NULL AND customer_id IS NULL)
         OR (target_type = 'SEGMENT' AND segment_id IS NOT NULL AND customer_id IS NULL)
         OR (target_type = 'CUSTOMER' AND customer_id IS NOT NULL AND segment_id IS NULL)`,
        [],
        'price_lists_target_check'
      )
      table.check(
        `priority BETWEEN 0 AND 1000 AND (valid_to IS NULL OR valid_to >= valid_from)
         AND (status <> 'INACTIVE' OR inactive_reason IS NOT NULL)
         AND (status NOT IN ('ACTIVE','INACTIVE') OR approved_by IS NOT NULL)
         AND (approved_by IS NULL OR approved_by IS DISTINCT FROM submitted_by)`,
        [],
        'price_lists_values_check'
      )
    })

    // Auto-referência: a chave única (tenant_id, id) só existe depois de criada a tabela.
    this.schema.raw(`ALTER TABLE price_lists ADD CONSTRAINT price_lists_copied_from_fk
      FOREIGN KEY (tenant_id, copied_from_id) REFERENCES price_lists (tenant_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'price_list_lines', (table) => {
      table.uuid('price_list_id').notNullable()
      table.uuid('product_id').notNullable()
      table.uuid('variant_id').nullable()
      table.decimal('min_quantity', 18, 6).notNullable().defaultTo(1)
      table.decimal('unit_price', 20, 4).notNullable()
      table.decimal('max_discount_pct', 5, 2).nullable()
      tenantForeignKey(table, 'price_list_id', 'price_lists')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      table.index(['tenant_id', 'price_list_id'], 'price_list_lines_list_index')
      table.index(['tenant_id', 'product_id'], 'price_list_lines_product_index')
      table.check(
        `min_quantity > 0 AND unit_price >= 0
         AND (max_discount_pct IS NULL OR max_discount_pct BETWEEN 0 AND 100)`,
        [],
        'price_list_lines_values_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX price_list_lines_tier_unique ON price_list_lines
      (tenant_id, price_list_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
       min_quantity)`)

    createTenantTable(this, 'discount_rules', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.string('target_type', 10).notNullable()
      table.uuid('segment_id').nullable()
      table.uuid('customer_id').nullable()
      table.uuid('product_id').nullable()
      table.uuid('category_id').nullable()
      table.decimal('min_quantity', 18, 6).notNullable().defaultTo(0)
      table.decimal('discount_pct', 5, 2).notNullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.integer('priority').notNullable().defaultTo(100)
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('notes', 1000).nullable()
      table.uuid('submitted_by').nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.uuid('approved_by').nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.string('inactive_reason', 500).nullable()
      tenantForeignKey(table, 'segment_id', 'customer_segments')
      tenantForeignKey(table, 'customer_id', 'customers')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'category_id', 'product_categories')
      table.unique(['tenant_id', 'code'], { indexName: 'discount_rules_code_unique' })
      table.check(
        `status IN ('DRAFT','PENDING','ACTIVE','INACTIVE')`,
        [],
        'discount_rules_status_check'
      )
      table.check(
        `((target_type = 'ALL' AND segment_id IS NULL AND customer_id IS NULL)
          OR (target_type = 'SEGMENT' AND segment_id IS NOT NULL AND customer_id IS NULL)
          OR (target_type = 'CUSTOMER' AND customer_id IS NOT NULL AND segment_id IS NULL))
         AND NOT (product_id IS NOT NULL AND category_id IS NOT NULL)`,
        [],
        'discount_rules_target_check'
      )
      table.check(
        `discount_pct > 0 AND discount_pct <= 100 AND min_quantity >= 0
         AND priority BETWEEN 0 AND 1000 AND (valid_to IS NULL OR valid_to >= valid_from)
         AND (status <> 'INACTIVE' OR inactive_reason IS NOT NULL)
         AND (status NOT IN ('ACTIVE','INACTIVE') OR approved_by IS NOT NULL)
         AND (approved_by IS NULL OR approved_by IS DISTINCT FROM submitted_by)`,
        [],
        'discount_rules_values_check'
      )
    })

    createTenantTable(this, 'discount_limits', (table) => {
      table.string('target_type', 10).notNullable()
      table.uuid('segment_id').nullable()
      table.uuid('customer_id').nullable()
      table.decimal('max_pct', 5, 2).notNullable()
      tenantForeignKey(table, 'segment_id', 'customer_segments')
      tenantForeignKey(table, 'customer_id', 'customers')
      table.check(
        `max_pct BETWEEN 0 AND 100 AND (
           (target_type = 'GENERAL' AND segment_id IS NULL AND customer_id IS NULL)
           OR (target_type = 'SEGMENT' AND segment_id IS NOT NULL AND customer_id IS NULL)
           OR (target_type = 'CUSTOMER' AND customer_id IS NOT NULL AND segment_id IS NULL))`,
        [],
        'discount_limits_values_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX discount_limits_target_unique ON discount_limits
      (tenant_id, target_type, COALESCE(segment_id, customer_id, '00000000-0000-0000-0000-000000000000'::uuid))`)

    createTenantTable(this, 'pricing_events', (table) => {
      table.string('subject_type', 15).notNullable()
      table.uuid('subject_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      table.index(['tenant_id', 'subject_type', 'subject_id'], 'pricing_events_subject_index')
      table.check(
        `subject_type IN ('PRICE_LIST','DISCOUNT_RULE')`,
        [],
        'pricing_events_subject_check'
      )
    })
    this.schema.raw(`
      CREATE FUNCTION pricing_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER pricing_events_fixed BEFORE UPDATE OR DELETE
      ON pricing_events FOR EACH ROW EXECUTE FUNCTION pricing_events_fixed()`)

    // Fora do rascunho, o conteúdo de uma tabela ou regra não muda (só o estado e os campos da decisão);
    // nunca se apagam (os documentos referem-nas).
    for (const [t, cols] of [
      [
        'price_lists',
        'code,name,currency,target_type,segment_id,customer_id,legal_entity_id,valid_from,valid_to,priority,notes',
      ],
      [
        'discount_rules',
        'code,name,target_type,segment_id,customer_id,product_id,category_id,min_quantity,discount_pct,valid_from,valid_to,priority,notes',
      ],
    ] as const) {
      const changed = cols
        .split(',')
        .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
        .join(' OR ')
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'PRICING_FIXED' USING ERRCODE = '23000';
          END IF;
          IF OLD.status <> 'DRAFT' AND (${changed}) THEN
            RAISE EXCEPTION 'PRICING_FIXED' USING ERRCODE = '23000';
          END IF;
          IF OLD.status = 'INACTIVE' AND NEW.status <> 'INACTIVE' THEN
            RAISE EXCEPTION 'PRICING_FIXED' USING ERRCODE = '23000';
          END IF;
          RETURN NEW;
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }
    this.schema.raw(`
      CREATE FUNCTION price_list_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s text;
      BEGIN
        SELECT status INTO s FROM price_lists
         WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
           AND id = COALESCE(NEW.price_list_id, OLD.price_list_id);
        IF s IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'PRICING_FIXED' USING ERRCODE = '23000';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.price_list_id IS DISTINCT FROM OLD.price_list_id THEN
          RAISE EXCEPTION 'PRICING_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema.raw(`CREATE TRIGGER price_list_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON price_list_lines FOR EACH ROW EXECUTE FUNCTION price_list_lines_fixed()`)
  }

  async down() {
    this.schema.dropTable('pricing_events')
    this.schema.dropTable('discount_limits')
    this.schema.dropTable('discount_rules')
    this.schema.dropTable('price_list_lines')
    this.schema.dropTable('price_lists')
    for (const f of [
      'pricing_events_fixed',
      'price_lists_fixed',
      'discount_rules_fixed',
      'price_list_lines_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
