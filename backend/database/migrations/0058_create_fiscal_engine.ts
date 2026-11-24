import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Motor fiscal e séries fiscais (Prompt 10, bloco 10.5) — módulo `sales`.
 *
 * Nada é pré-carregado: a empresa configura os impostos, as taxas, as isenções e as retenções a partir das fontes
 * oficiais, indica a fonte legal de cada valor e outra pessoa confirma-o. Só valores confirmados e em vigor entram nos
 * cálculos.
 *
 *  - `tax_codes`: imposto ou retenção de um país (código interno, tipo, nome).
 *  - `tax_rates`: taxa de um código, do país ou só de uma entidade legal, com vigência e fonte legal; rascunho →
 *    confirmada (por outra pessoa) → retirada. Confirmada não muda (gatilho); vigências confirmadas não se sobrepõem.
 *  - `tax_exemptions`: motivos de isenção (código como na fonte oficial, descrição, fonte legal) com a mesma confirmação.
 *  - `tax_settings`: por entidade legal, o nível de arredondamento do imposto (por linha ou por documento).
 *  - `fiscal_series`: séries fiscais por entidade, tipo de documento e ano, várias em simultâneo; sequência sem saltos
 *    e cronológica; só em modo SIMULAÇÃO enquanto não houver certificação e especificação oficial.
 *  - `fiscal_numbers`: registo de cada número atribuído (único por série; só de acréscimo).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'tax_codes', (table) => {
      table.specificType('country_code', 'char(2)').notNullable()
      table.string('code', 20).notNullable()
      table.string('name', 120).notNullable()
      table.string('kind', 12).notNullable()
      table.string('tax_type', 12).notNullable()
      table.string('status', 10).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'country_code', 'code'], { indexName: 'tax_codes_code_unique' })
      table.check(
        `kind IN ('TAX','WITHHOLDING') AND tax_type IN ('VAT','STAMP','INCOME','OTHER') AND status IN ('ACTIVE','INACTIVE')`,
        [],
        'tax_codes_values_check'
      )
    })

    createTenantTable(this, 'tax_rates', (table) => {
      table.uuid('tax_code_id').notNullable()
      table.uuid('legal_entity_id').nullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.decimal('rate', 7, 4).notNullable()
      table.decimal('min_base', 20, 2).nullable()
      table.string('legal_source', 300).notNullable()
      table.string('notes', 500).nullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.uuid('confirmed_by').nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.string('retired_reason', 500).nullable()
      tenantForeignKey(table, 'tax_code_id', 'tax_codes')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.index(['tenant_id', 'tax_code_id'], 'tax_rates_code_index')
      table.check(
        `rate >= 0 AND rate <= 100 AND (min_base IS NULL OR min_base >= 0)
         AND (valid_to IS NULL OR valid_to >= valid_from)
         AND status IN ('DRAFT','CONFIRMED','RETIRED')
         AND (status = 'DRAFT' OR confirmed_by IS NOT NULL)
         AND (confirmed_by IS NULL OR confirmed_by <> created_by)
         AND (status <> 'RETIRED' OR retired_reason IS NOT NULL)`,
        [],
        'tax_rates_values_check'
      )
    })

    createTenantTable(this, 'tax_exemptions', (table) => {
      table.specificType('country_code', 'char(2)').notNullable()
      table.string('code', 20).notNullable()
      table.string('description', 300).notNullable()
      table.string('legal_source', 300).notNullable()
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.uuid('confirmed_by').nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.string('retired_reason', 500).nullable()
      table.unique(['tenant_id', 'country_code', 'code'], {
        indexName: 'tax_exemptions_code_unique',
      })
      table.check(
        `status IN ('DRAFT','CONFIRMED','RETIRED') AND (status = 'DRAFT' OR confirmed_by IS NOT NULL)
         AND (confirmed_by IS NULL OR confirmed_by <> created_by)
         AND (status <> 'RETIRED' OR retired_reason IS NOT NULL)`,
        [],
        'tax_exemptions_values_check'
      )
    })

    createTenantTable(this, 'tax_settings', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('rounding_level', 10).notNullable().defaultTo('LINE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'legal_entity_id'], { indexName: 'tax_settings_entity_unique' })
      table.check(`rounding_level IN ('LINE','DOCUMENT')`, [], 'tax_settings_rounding_check')
    })

    createTenantTable(this, 'fiscal_series', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('document_kind', 20).notNullable()
      table.string('fiscal_code', 10).notNullable()
      table.string('code', 30).notNullable()
      table.integer('fiscal_year').notNullable()
      table.string('prefix', 30).notNullable()
      table.integer('padding').notNullable().defaultTo(0)
      table.integer('next_number').notNullable().defaultTo(1)
      table.date('last_issue_date').nullable()
      table.string('mode', 12).notNullable().defaultTo('SIMULATION')
      table.string('status', 10).notNullable().defaultTo('DRAFT')
      table.string('authority_reference', 120).nullable()
      table.string('closed_reason', 500).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], {
        indexName: 'fiscal_series_code_unique',
      })
      table.check(
        `document_kind IN ('INVOICE','INVOICE_RECEIPT','CREDIT_NOTE','DEBIT_NOTE','RECEIPT')
         AND fiscal_year BETWEEN 2000 AND 2100 AND padding BETWEEN 0 AND 10 AND next_number >= 1
         AND mode IN ('SIMULATION','PRODUCTION') AND status IN ('DRAFT','ACTIVE','CLOSED')
         AND mode = 'SIMULATION'
         AND (status <> 'CLOSED' OR closed_reason IS NOT NULL)`,
        [],
        'fiscal_series_values_check'
      )
    })

    createTenantTable(this, 'fiscal_numbers', (table) => {
      table.uuid('series_id').notNullable()
      table.integer('number').notNullable()
      table.string('formatted', 60).notNullable()
      table.date('issue_date').notNullable()
      table.string('document_type', 30).notNullable()
      table.uuid('document_id').notNullable()
      tenantForeignKey(table, 'series_id', 'fiscal_series')
      table.unique(['tenant_id', 'series_id', 'number'], {
        indexName: 'fiscal_numbers_number_unique',
      })
      table.unique(['tenant_id', 'document_type', 'document_id'], {
        indexName: 'fiscal_numbers_document_unique',
      })
    })

    this.schema.raw(`
      CREATE FUNCTION fiscal_numbers_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '23000';
      END $$`)
    this.schema.raw(`CREATE TRIGGER fiscal_numbers_fixed BEFORE UPDATE OR DELETE
      ON fiscal_numbers FOR EACH ROW EXECUTE FUNCTION fiscal_numbers_fixed()`)

    // Taxas e isenções confirmadas não mudam (só se retiram com motivo); nunca se apagam.
    for (const [t, cols] of [
      ['tax_rates', 'tax_code_id,legal_entity_id,valid_from,valid_to,rate,min_base,legal_source'],
      ['tax_exemptions', 'country_code,code,description,legal_source'],
    ] as const) {
      const changed = cols
        .split(',')
        .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
        .join(' OR ')
      this.schema.raw(`
        CREATE FUNCTION ${t}_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'FISCAL_FIXED' USING ERRCODE = '23000'; END IF;
            RETURN OLD;
          END IF;
          IF OLD.status <> 'DRAFT' AND (${changed}) THEN
            RAISE EXCEPTION 'FISCAL_FIXED' USING ERRCODE = '23000';
          END IF;
          IF OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED' THEN
            RAISE EXCEPTION 'FISCAL_FIXED' USING ERRCODE = '23000';
          END IF;
          RETURN NEW;
        END $$`)
      this.schema.raw(`CREATE TRIGGER ${t}_fixed BEFORE UPDATE OR DELETE
        ON ${t} FOR EACH ROW EXECUTE FUNCTION ${t}_fixed()`)
    }

    // Série: a numeração só avança (de um em um, pela atribuição), a configuração fixa-se ao activar, fechada é final.
    this.schema.raw(`
      CREATE FUNCTION fiscal_series_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'FISCAL_FIXED' USING ERRCODE = '23000'; END IF;
          RETURN OLD;
        END IF;
        IF NEW.next_number < OLD.next_number OR NEW.next_number > OLD.next_number + 1 THEN
          RAISE EXCEPTION 'FISCAL_SEQUENCE' USING ERRCODE = '23000';
        END IF;
        IF OLD.status <> 'DRAFT' AND (NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
            OR NEW.document_kind IS DISTINCT FROM OLD.document_kind OR NEW.fiscal_code IS DISTINCT FROM OLD.fiscal_code
            OR NEW.code IS DISTINCT FROM OLD.code OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
            OR NEW.prefix IS DISTINCT FROM OLD.prefix OR NEW.padding IS DISTINCT FROM OLD.padding
            OR NEW.mode IS DISTINCT FROM OLD.mode) THEN
          RAISE EXCEPTION 'FISCAL_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'CLOSED' AND (NEW.status <> 'CLOSED' OR NEW.next_number <> OLD.next_number) THEN
          RAISE EXCEPTION 'FISCAL_FIXED' USING ERRCODE = '23000';
        END IF;
        IF OLD.status = 'DRAFT' AND NEW.next_number <> OLD.next_number THEN
          RAISE EXCEPTION 'FISCAL_SEQUENCE' USING ERRCODE = '23000';
        END IF;
        RETURN NEW;
      END $$`)
    this.schema.raw(`CREATE TRIGGER fiscal_series_fixed BEFORE UPDATE OR DELETE
      ON fiscal_series FOR EACH ROW EXECUTE FUNCTION fiscal_series_fixed()`)
  }

  async down() {
    this.schema.dropTable('fiscal_numbers')
    this.schema.dropTable('fiscal_series')
    this.schema.dropTable('tax_settings')
    this.schema.dropTable('tax_exemptions')
    this.schema.dropTable('tax_rates')
    this.schema.dropTable('tax_codes')
    for (const f of [
      'fiscal_numbers_fixed',
      'tax_rates_fixed',
      'tax_exemptions_fixed',
      'fiscal_series_fixed',
    ])
      this.schema.raw(`DROP FUNCTION ${f}()`)
  }
}
