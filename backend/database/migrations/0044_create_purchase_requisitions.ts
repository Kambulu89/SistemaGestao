import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Requisições de compra (Prompt 09, bloco 9.2).
 *
 *  - `purchase_approval_levels`: etapas de aprovação por valor (em moeda funcional), opcionalmente por entidade legal e
 *    exigindo um perfil. Uma requisição precisa de todas as etapas cujo mínimo atinge (pelo menos uma).
 *  - `purchase_requisitions` + `purchase_requisition_lines`: cabeçalho (entidade, filial, departamento, centro de custo,
 *    solicitante, prioridade, necessidade, orçamento, moeda) e linhas (produto ou descrição livre, quantidade, unidade,
 *    preço estimado, imposto, totais exactos, entrega); quantidades encomendadas e fechadas para o atendimento parcial.
 *  - `purchase_requisition_approvals`: cada decisão por etapa (só acréscimo; uma por etapa; o solicitante nunca decide).
 *  - `purchase_requisition_allocations`: o que cotações/ordens consumiram de cada linha (só acréscimo, idempotente).
 *  - `purchase_requisition_events`: histórico só de acréscimo.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'purchase_approval_levels', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.integer('sequence').notNullable()
      table.decimal('min_amount', 20, 2).notNullable()
      table.uuid('legal_entity_id').nullable()
      table.uuid('approver_role_id').nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'approver_role_id', 'roles')
      table.unique(['tenant_id', 'code'], { indexName: 'purchase_approval_levels_code_unique' })
      table.check(
        'min_amount >= 0 AND sequence BETWEEN 1 AND 99',
        [],
        'purchase_approval_levels_values_check'
      )
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'purchase_approval_levels_status_check')
    })

    // Um rascunho anulado nunca teve número; tudo o que saiu do rascunho tem número, total funcional e etapas.
    createTenantTable(this, 'purchase_requisitions', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.uuid('department_id').notNullable()
      table.uuid('cost_center_id').nullable()
      table.uuid('requested_by_membership_id').notNullable()
      table.uuid('requested_by_user_id').notNullable()
      table.string('priority', 8).notNullable().defaultTo('NORMAL')
      table.date('needed_by').notNullable()
      table.string('purpose', 500).notNullable()
      table.string('budget_reference', 60).nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.decimal('total_net', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_tax', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_amount', 20, 2).notNullable().defaultTo(0)
      table.decimal('total_functional', 20, 2).nullable()
      table.decimal('exchange_rate', 20, 10).nullable()
      table.jsonb('required_levels').nullable()
      table.uuid('series_id').nullable()
      table.string('number', 40).nullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.timestamp('submitted_at', { useTz: true }).nullable()
      table.timestamp('approved_at', { useTz: true }).nullable()
      table.string('reject_reason', 500).nullable()
      table.string('cancel_reason', 500).nullable()
      table.string('close_reason', 500).nullable()
      table.uuid('copied_from_id').nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      tenantForeignKey(table, 'department_id', 'departments')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'requested_by_membership_id', 'tenant_memberships')
      tenantForeignKey(table, 'series_id', 'document_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'purchase_requisitions_number_unique',
      })
      table.index(['tenant_id', 'status'], 'purchase_requisitions_status_index')
      table.check(
        `priority IN ('LOW','NORMAL','HIGH','URGENT')`,
        [],
        'purchase_requisitions_priority_check'
      )
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIALLY_ORDERED','ORDERED','REJECTED','CANCELLED','CLOSED')`,
        [],
        'purchase_requisitions_status_check'
      )
      table.check(
        `status IN ('DRAFT','CANCELLED') OR (number IS NOT NULL AND total_functional IS NOT NULL AND required_levels IS NOT NULL)`,
        [],
        'purchase_requisitions_submitted_check'
      )
      table.check(
        'total_net >= 0 AND total_tax >= 0 AND total_amount = total_net + total_tax',
        [],
        'purchase_requisitions_totals_check'
      )
    })

    // A cópia aponta para a original (a chave única (tenant_id, id) só existe depois de criada a tabela).
    this.schema.alterTable('purchase_requisitions', (table) => {
      tenantForeignKey(table, 'copied_from_id', 'purchase_requisitions')
    })

    createTenantTable(this, 'purchase_requisition_lines', (table) => {
      table.uuid('requisition_id').notNullable()
      table.integer('line_no').notNullable()
      table.uuid('product_id').nullable()
      table.uuid('variant_id').nullable()
      table.string('description', 300).notNullable()
      table.uuid('uom_id').nullable()
      table.string('uom_code', 20).nullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.decimal('estimated_unit_price', 20, 6).notNullable()
      table.decimal('tax_rate', 6, 3).notNullable().defaultTo(0)
      table.decimal('net_amount', 20, 2).notNullable()
      table.decimal('tax_amount', 20, 2).notNullable()
      table.decimal('total_amount', 20, 2).notNullable()
      table.date('needed_by').nullable()
      table.uuid('suggested_supplier_id').nullable()
      table.string('notes', 500).nullable()
      table.decimal('ordered_quantity', 18, 6).notNullable().defaultTo(0)
      table.decimal('closed_quantity', 18, 6).notNullable().defaultTo(0)
      tenantForeignKey(table, 'requisition_id', 'purchase_requisitions', 'CASCADE')
      tenantForeignKey(table, 'product_id', 'products')
      tenantForeignKey(table, 'variant_id', 'product_variants')
      tenantForeignKey(table, 'uom_id', 'uoms')
      tenantForeignKey(table, 'suggested_supplier_id', 'suppliers')
      table.unique(['tenant_id', 'requisition_id', 'line_no'], {
        indexName: 'purchase_requisition_lines_no_unique',
      })
      table.index(['tenant_id', 'product_id'], 'purchase_requisition_lines_product_index')
      table.check(
        'quantity > 0 AND estimated_unit_price >= 0 AND tax_rate BETWEEN 0 AND 100',
        [],
        'purchase_requisition_lines_values_check'
      )
      table.check(
        'ordered_quantity >= 0 AND closed_quantity >= 0 AND ordered_quantity + closed_quantity <= quantity',
        [],
        'purchase_requisition_lines_fulfilment_check'
      )
      table.check(
        'total_amount = net_amount + tax_amount',
        [],
        'purchase_requisition_lines_totals_check'
      )
      table.check(
        'product_id IS NOT NULL OR variant_id IS NULL',
        [],
        'purchase_requisition_lines_variant_check'
      )
    })

    createTenantTable(this, 'purchase_requisition_approvals', (table) => {
      table.uuid('requisition_id').notNullable()
      table.uuid('level_id').nullable()
      table.string('level_code', 30).notNullable()
      table.integer('sequence').notNullable()
      table.string('decision', 8).notNullable()
      table.uuid('decided_by_membership_id').notNullable()
      table.uuid('decided_by_user_id').notNullable()
      table.string('reason', 500).nullable()
      tenantForeignKey(table, 'requisition_id', 'purchase_requisitions')
      tenantForeignKey(table, 'level_id', 'purchase_approval_levels')
      table.unique(['tenant_id', 'requisition_id', 'sequence'], {
        indexName: 'purchase_requisition_approvals_step_unique',
      })
      table.check(
        `decision IN ('APPROVE','REJECT')`,
        [],
        'purchase_requisition_approvals_decision_check'
      )
      table.check(
        `decision = 'APPROVE' OR reason IS NOT NULL`,
        [],
        'purchase_requisition_approvals_reason_check'
      )
    })

    createTenantTable(this, 'purchase_requisition_allocations', (table) => {
      table.uuid('line_id').notNullable()
      table.string('source_type', 30).notNullable()
      table.uuid('source_id').notNullable()
      table.uuid('source_line_id').nullable()
      table.decimal('quantity', 18, 6).notNullable()
      table.string('idempotency_key', 120).notNullable()
      tenantForeignKey(table, 'line_id', 'purchase_requisition_lines')
      table.unique(['tenant_id', 'idempotency_key'], {
        indexName: 'purchase_requisition_allocations_key_unique',
      })
      table.index(
        ['tenant_id', 'source_type', 'source_id'],
        'purchase_requisition_allocations_source_index'
      )
      table.check('quantity <> 0', [], 'purchase_requisition_allocations_quantity_check')
    })

    createTenantTable(this, 'purchase_requisition_events', (table) => {
      table.uuid('requisition_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('from_status', 20).nullable()
      table.string('to_status', 20).nullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'requisition_id', 'purchase_requisitions')
      table.index(['tenant_id', 'requisition_id'], 'purchase_requisition_events_req_index')
    })

    // Só acréscimo: decisões, afectações e histórico.
    for (const t of [
      'purchase_requisition_approvals',
      'purchase_requisition_allocations',
      'purchase_requisition_events',
    ]) {
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }
    // Fora do rascunho, as linhas só mudam nas quantidades encomendadas/fechadas; o cabeçalho só no estado e decisões.
    this.schema.raw(`
      CREATE FUNCTION purchase_requisition_lines_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE st text;
      BEGIN
        SELECT status INTO st FROM purchase_requisitions WHERE id = COALESCE(OLD.requisition_id, NEW.requisition_id);
        IF st IS DISTINCT FROM 'DRAFT' THEN
          IF TG_OP <> 'UPDATE' OR NEW.product_id IS DISTINCT FROM OLD.product_id
             OR NEW.description IS DISTINCT FROM OLD.description OR NEW.quantity IS DISTINCT FROM OLD.quantity
             OR NEW.estimated_unit_price IS DISTINCT FROM OLD.estimated_unit_price
             OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
             OR NEW.uom_id IS DISTINCT FROM OLD.uom_id OR NEW.needed_by IS DISTINCT FROM OLD.needed_by
             OR NEW.suggested_supplier_id IS DISTINCT FROM OLD.suggested_supplier_id THEN
            RAISE EXCEPTION 'REQUISITION_LINE_FIXED' USING ERRCODE = '23000';
          END IF;
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$`)
    this.schema
      .raw(`CREATE TRIGGER purchase_requisition_lines_fixed BEFORE INSERT OR UPDATE OR DELETE
      ON purchase_requisition_lines FOR EACH ROW EXECUTE FUNCTION purchase_requisition_lines_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION purchase_requisitions_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'REQUISITION_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'DRAFT' AND (
             NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id OR NEW.department_id IS DISTINCT FROM OLD.department_id
             OR NEW.cost_center_id IS DISTINCT FROM OLD.cost_center_id OR NEW.currency IS DISTINCT FROM OLD.currency
             OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.number IS DISTINCT FROM OLD.number
             OR NEW.required_levels IS DISTINCT FROM OLD.required_levels
             OR NEW.requested_by_membership_id IS DISTINCT FROM OLD.requested_by_membership_id
             OR OLD.status IN ('REJECTED','CANCELLED')) THEN
          RAISE EXCEPTION 'REQUISITION_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER purchase_requisitions_fixed BEFORE UPDATE OR DELETE
      ON purchase_requisitions FOR EACH ROW EXECUTE FUNCTION purchase_requisitions_fixed()`)
  }

  async down() {
    this.schema.dropTable('purchase_requisition_events')
    this.schema.dropTable('purchase_requisition_allocations')
    this.schema.dropTable('purchase_requisition_approvals')
    this.schema.dropTable('purchase_requisition_lines')
    this.schema.dropTable('purchase_requisitions')
    this.schema.dropTable('purchase_approval_levels')
    for (const f of [
      'purchase_requisitions_fixed',
      'purchase_requisition_lines_fixed',
      'purchase_requisition_events_fixed',
      'purchase_requisition_allocations_fixed',
      'purchase_requisition_approvals_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
