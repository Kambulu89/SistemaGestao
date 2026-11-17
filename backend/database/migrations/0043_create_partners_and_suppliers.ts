import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Terceiros e fornecedores (Prompt 09, bloco 9.1).
 *
 *  - `business_partners`: o terceiro (pessoa colectiva ou singular) — identidade fiscal, país, contactos e morada. É
 *    reutilizável: o mesmo terceiro pode ser fornecedor (aqui) e cliente (Prompt 10). NIF único por país.
 *  - `suppliers`: o papel de fornecedor de um terceiro (um por terceiro) — tipo, condições comerciais e estado de
 *    homologação (rascunho → em aprovação → homologado / recusado; suspenso).
 *  - `supplier_document_types` e `supplier_criteria`: o que a empresa exige para homologar (configurável).
 *  - `supplier_documents`: certidões, alvarás e outros, com validade; o ficheiro é um anexo.
 *  - `supplier_reviews` + `supplier_review_items`: cada pedido de homologação com a avaliação de cada critério e a
 *    decisão; fixo depois de decidido.
 *  - `supplier_bank_accounts`: dados bancários protegidos — entram pendentes e só ficam activos com a aprovação de
 *    outra pessoa; o conteúdo não se altera (substitui-se).
 *  - `supplier_events`: histórico só de acréscimo.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'business_partners', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 200).notNullable()
      table.string('partner_type', 12).notNullable()
      table.string('tax_id', 30).nullable()
      table.specificType('country_code', 'char(2)').notNullable()
      table.string('email', 160).nullable()
      table.string('phone', 40).nullable()
      table.string('website', 200).nullable()
      table.string('address_line', 200).nullable()
      table.string('city', 100).nullable()
      table.string('province', 100).nullable()
      table.string('postal_code', 20).nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'business_partners_code_unique' })
      table.check(
        `partner_type IN ('ORGANIZATION','INDIVIDUAL')`,
        [],
        'business_partners_type_check'
      )
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'business_partners_status_check')
    })
    this.schema.raw(`CREATE UNIQUE INDEX business_partners_tax_id_unique
      ON business_partners (tenant_id, country_code, tax_id) WHERE tax_id IS NOT NULL`)

    createTenantTable(this, 'business_partner_contacts', (table) => {
      table.uuid('partner_id').notNullable()
      table.string('name', 160).notNullable()
      table.string('role', 100).nullable()
      table.string('email', 160).nullable()
      table.string('phone', 40).nullable()
      table.boolean('is_primary').notNullable().defaultTo(false)
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'partner_id', 'business_partners')
      table.index(['tenant_id', 'partner_id'], 'business_partner_contacts_partner_index')
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'business_partner_contacts_status_check')
    })
    this.schema.raw(`CREATE UNIQUE INDEX business_partner_contacts_primary_unique
      ON business_partner_contacts (tenant_id, partner_id) WHERE is_primary AND status = 'ACTIVE'`)

    for (const name of ['supplier_document_types', 'supplier_criteria']) {
      createTenantTable(this, name, (table) => {
        table.string('code', 30).notNullable()
        table.string('name', 160).notNullable()
        table.text('description').nullable()
        table.boolean('required').notNullable().defaultTo(false)
        table.string('status', 10).notNullable().defaultTo('ACTIVE')
        table.unique(['tenant_id', 'code'], { indexName: `${name}_code_unique` })
        table.check(`status IN ('ACTIVE','INACTIVE')`, [], `${name}_status_check`)
      })
    }

    createTenantTable(this, 'suppliers', (table) => {
      table.uuid('partner_id').notNullable()
      table.string('supplier_type', 10).notNullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.integer('payment_terms_days').notNullable().defaultTo(0)
      table.string('payment_method', 10).notNullable().defaultTo('TRANSFER')
      table.integer('lead_time_days').nullable()
      table.decimal('min_order_amount', 20, 2).nullable()
      table.string('incoterm', 3).nullable()
      table.text('notes').nullable()
      table.string('status', 20).notNullable().defaultTo('DRAFT')
      table.timestamp('approved_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'partner_id', 'business_partners')
      // Um terceiro tem no máximo um papel de fornecedor.
      table.unique(['tenant_id', 'partner_id'], { indexName: 'suppliers_partner_unique' })
      table.index(['tenant_id', 'status'], 'suppliers_status_index')
      table.check(`supplier_type IN ('GOODS','SERVICES','BOTH')`, [], 'suppliers_type_check')
      table.check(
        `payment_method IN ('TRANSFER','CHEQUE','CASH','OTHER')`,
        [],
        'suppliers_payment_method_check'
      )
      table.check(
        `status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','SUSPENDED')`,
        [],
        'suppliers_status_check'
      )
      table.check(
        'payment_terms_days BETWEEN 0 AND 365 AND (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 730)',
        [],
        'suppliers_days_check'
      )
      table.check(
        'min_order_amount IS NULL OR min_order_amount >= 0',
        [],
        'suppliers_min_order_check'
      )
    })

    createTenantTable(this, 'supplier_documents', (table) => {
      table.uuid('supplier_id').notNullable()
      table.uuid('document_type_id').notNullable()
      table.string('number', 60).nullable()
      table.date('issued_on').nullable()
      table.date('valid_until').nullable()
      table.uuid('attachment_id').nullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.string('inactive_reason', 300).nullable()
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      tenantForeignKey(table, 'document_type_id', 'supplier_document_types')
      tenantForeignKey(table, 'attachment_id', 'attachments')
      table.index(['tenant_id', 'supplier_id'], 'supplier_documents_supplier_index')
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'supplier_documents_status_check')
      table.check(
        'valid_until IS NULL OR issued_on IS NULL OR valid_until >= issued_on',
        [],
        'supplier_documents_dates_check'
      )
      table.check(
        `(status = 'INACTIVE') = (inactive_reason IS NOT NULL)`,
        [],
        'supplier_documents_reason_check'
      )
    })
    // O documento é o que foi entregue: só se pode desactivar (com motivo).
    this.schema.raw(`
      CREATE FUNCTION supplier_documents_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
           OR NEW.document_type_id IS DISTINCT FROM OLD.document_type_id
           OR NEW.number IS DISTINCT FROM OLD.number OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
           OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.attachment_id IS DISTINCT FROM OLD.attachment_id
           OR (OLD.status = 'INACTIVE' AND NEW.status IS DISTINCT FROM OLD.status) THEN
          RAISE EXCEPTION 'SUPPLIER_DOCUMENT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER supplier_documents_fixed BEFORE UPDATE OR DELETE
      ON supplier_documents FOR EACH ROW EXECUTE FUNCTION supplier_documents_fixed()`)

    createTenantTable(this, 'supplier_reviews', (table) => {
      table.uuid('supplier_id').notNullable()
      table.string('status', 12).notNullable().defaultTo('PENDING')
      table.uuid('submitted_by').notNullable()
      table.timestamp('submitted_at', { useTz: true }).notNullable()
      table.text('notes').nullable()
      table.jsonb('documents').notNullable()
      table.uuid('decided_by').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.string('decision_reason', 500).nullable()
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      table.index(['tenant_id', 'supplier_id'], 'supplier_reviews_supplier_index')
      table.check(
        `status IN ('PENDING','APPROVED','REJECTED','CANCELLED')`,
        [],
        'supplier_reviews_status_check'
      )
      table.check(
        `(status = 'PENDING') = (decided_at IS NULL)`,
        [],
        'supplier_reviews_decided_check'
      )
      // Quem submete não decide.
      table.check(
        'decided_by IS NULL OR decided_by <> submitted_by',
        [],
        'supplier_reviews_segregation_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX supplier_reviews_pending_unique
      ON supplier_reviews (tenant_id, supplier_id) WHERE status = 'PENDING'`)

    createTenantTable(this, 'supplier_review_items', (table) => {
      table.uuid('review_id').notNullable()
      table.uuid('criterion_id').notNullable()
      table.string('criterion_code', 30).notNullable()
      table.string('criterion_name', 160).notNullable()
      table.boolean('required').notNullable()
      table.string('result', 14).notNullable()
      table.string('notes', 1000).nullable()
      tenantForeignKey(table, 'review_id', 'supplier_reviews')
      tenantForeignKey(table, 'criterion_id', 'supplier_criteria')
      table.unique(['tenant_id', 'review_id', 'criterion_id'], {
        indexName: 'supplier_review_items_unique',
      })
      table.check(
        `result IN ('MET','NOT_MET','NOT_APPLICABLE')`,
        [],
        'supplier_review_items_result_check'
      )
    })
    // Decidida, a revisão (e as suas linhas) fica como foi decidida.
    this.schema.raw(`
      CREATE FUNCTION supplier_reviews_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status <> 'PENDING' OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
           OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.documents IS DISTINCT FROM OLD.documents
           OR NEW.notes IS DISTINCT FROM OLD.notes THEN
          RAISE EXCEPTION 'SUPPLIER_REVIEW_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER supplier_reviews_fixed BEFORE UPDATE OR DELETE
      ON supplier_reviews FOR EACH ROW EXECUTE FUNCTION supplier_reviews_fixed()`)
    this.schema.raw(`
      CREATE FUNCTION supplier_review_items_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'SUPPLIER_REVIEW_FIXED' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER supplier_review_items_fixed BEFORE UPDATE OR DELETE
      ON supplier_review_items FOR EACH ROW EXECUTE FUNCTION supplier_review_items_fixed()`)

    createTenantTable(this, 'supplier_bank_accounts', (table) => {
      table.uuid('supplier_id').notNullable()
      table.string('holder_name', 200).notNullable()
      table.string('bank_name', 160).notNullable()
      table.string('iban', 34).nullable()
      table.string('account_number', 40).nullable()
      table.string('swift_bic', 11).nullable()
      table.specificType('currency', 'char(3)').notNullable()
      table.string('status', 20).notNullable().defaultTo('PENDING_APPROVAL')
      table.uuid('requested_by').notNullable()
      table.uuid('decided_by').nullable()
      table.timestamp('decided_at', { useTz: true }).nullable()
      table.string('decision_reason', 500).nullable()
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      table.index(['tenant_id', 'supplier_id'], 'supplier_bank_accounts_supplier_index')
      table.check(
        `status IN ('PENDING_APPROVAL','ACTIVE','REJECTED','INACTIVE')`,
        [],
        'supplier_bank_accounts_status_check'
      )
      table.check(
        'iban IS NOT NULL OR account_number IS NOT NULL',
        [],
        'supplier_bank_accounts_identifier_check'
      )
      table.check(
        'decided_by IS NULL OR decided_by <> requested_by',
        [],
        'supplier_bank_accounts_segregation_check'
      )
    })
    this.schema.raw(`CREATE UNIQUE INDEX supplier_bank_accounts_iban_unique
      ON supplier_bank_accounts (tenant_id, supplier_id, iban)
      WHERE iban IS NOT NULL AND status IN ('PENDING_APPROVAL','ACTIVE')`)
    // Os dados bancários não se editam: muda-se o estado (aprovar, recusar, desactivar) e entra uma conta nova.
    this.schema.raw(`
      CREATE FUNCTION supplier_bank_accounts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
           OR NEW.holder_name IS DISTINCT FROM OLD.holder_name OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
           OR NEW.iban IS DISTINCT FROM OLD.iban OR NEW.account_number IS DISTINCT FROM OLD.account_number
           OR NEW.swift_bic IS DISTINCT FROM OLD.swift_bic OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
           OR OLD.status IN ('REJECTED','INACTIVE') THEN
          RAISE EXCEPTION 'SUPPLIER_BANK_ACCOUNT_FIXED' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER supplier_bank_accounts_fixed BEFORE UPDATE OR DELETE
      ON supplier_bank_accounts FOR EACH ROW EXECUTE FUNCTION supplier_bank_accounts_fixed()`)

    createTenantTable(this, 'supplier_events', (table) => {
      table.uuid('supplier_id').notNullable()
      table.string('kind', 30).notNullable()
      table.string('from_status', 20).nullable()
      table.string('to_status', 20).nullable()
      table.string('reason', 500).nullable()
      table.jsonb('details').nullable()
      tenantForeignKey(table, 'supplier_id', 'suppliers')
      table.index(['tenant_id', 'supplier_id'], 'supplier_events_supplier_index')
    })
    this.schema.raw(`
      CREATE FUNCTION supplier_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'SUPPLIER_EVENT_FIXED' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER supplier_events_fixed BEFORE UPDATE OR DELETE
      ON supplier_events FOR EACH ROW EXECUTE FUNCTION supplier_events_fixed()`)
  }

  async down() {
    this.schema.dropTable('supplier_events')
    this.schema.dropTable('supplier_bank_accounts')
    this.schema.dropTable('supplier_review_items')
    this.schema.dropTable('supplier_reviews')
    this.schema.dropTable('supplier_documents')
    this.schema.dropTable('suppliers')
    this.schema.dropTable('supplier_criteria')
    this.schema.dropTable('supplier_document_types')
    this.schema.dropTable('business_partner_contacts')
    this.schema.dropTable('business_partners')
    for (const f of [
      'supplier_events_fixed',
      'supplier_bank_accounts_fixed',
      'supplier_review_items_fixed',
      'supplier_reviews_fixed',
      'supplier_documents_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
