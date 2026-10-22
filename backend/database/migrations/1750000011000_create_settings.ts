import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Configurações, referências, impostos e sequências (C09). Tudo de tenant, com RLS e auditoria.
 * As **definições** de chaves (tipo, âmbitos permitidos, valor por omissão) são entregues por código.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'setting_values', (table) => {
      table.string('key', 100).notNullable()
      table.string('scope_type', 12).notNullable()
      table.uuid('scope_id').nullable()
      table.string('module_code', 50).nullable()
      table.jsonb('value').notNullable()
    })
    this.schema.raw(`
      ALTER TABLE setting_values
        ADD CONSTRAINT setting_values_scope_check CHECK (
          (scope_type = 'TENANT' AND scope_id IS NULL AND module_code IS NULL)
          OR (scope_type IN ('ORGANIZATION', 'MEMBERSHIP') AND scope_id IS NOT NULL AND module_code IS NULL)
          OR (scope_type = 'BRANCH' AND scope_id IS NOT NULL)
          OR (scope_type = 'MODULE' AND scope_id IS NULL AND module_code IS NOT NULL))
    `)
    // Um valor por âmbito (a combinação filial+módulo é um âmbito próprio).
    this.schema.raw(`
      CREATE UNIQUE INDEX setting_values_scope_unique ON setting_values
        (tenant_id, key, scope_type, COALESCE(scope_id, '${ZERO_UUID}'::uuid), COALESCE(module_code, ''))
    `)

    createTenantTable(this, 'tax_rates', (table) => {
      table.uuid('organization_id').notNullable()
      table.string('code', 40).notNullable()
      table.string('name', 160).notNullable()
      table.decimal('rate', 9, 4).notNullable()
      table.date('valid_from').notNullable()
      table.date('valid_to').nullable()
      table.string('category', 50).notNullable()
      table.string('exemption_reason', 250).nullable()
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.index(['tenant_id', 'organization_id', 'code'])
    })
    this.schema.raw(`
      ALTER TABLE tax_rates
        ADD CONSTRAINT tax_rates_rate_check CHECK (rate >= 0),
        ADD CONSTRAINT tax_rates_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from)
    `)
    // Períodos sobrepostos para o mesmo código e organização são rejeitados na base (também sob concorrência).
    this.schema.raw(`
      CREATE FUNCTION tax_rates_no_overlap() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(
          hashtext('tax_rates:' || NEW.tenant_id::text || ':' || NEW.organization_id::text || ':' || NEW.code));
        IF EXISTS (
          SELECT 1 FROM tax_rates t
           WHERE t.tenant_id = NEW.tenant_id AND t.organization_id = NEW.organization_id
             AND t.code = NEW.code AND t.id <> NEW.id
             AND daterange(t.valid_from, t.valid_to, '[]') && daterange(NEW.valid_from, NEW.valid_to, '[]')
        ) THEN
          RAISE EXCEPTION 'TAX_RATE_OVERLAP' USING ERRCODE = '23P01';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    this.schema.raw(`
      CREATE TRIGGER tax_rates_no_overlap BEFORE INSERT OR UPDATE ON tax_rates
        FOR EACH ROW EXECUTE FUNCTION tax_rates_no_overlap()
    `)

    createTenantTable(this, 'units_of_measure', (table) => {
      table.string('code', 20).notNullable()
      table.string('name', 120).notNullable()
      table.string('dimension', 30).notNullable()
      table.integer('precision').notNullable().defaultTo(0)
      table.uuid('base_unit_id').nullable()
      table.decimal('conversion_factor', 19, 6).nullable()
      table.unique(['tenant_id', 'code'])
    })
    // FK composta para a própria tabela (a chave (tenant_id, id) só existe depois do CREATE).
    this.schema.raw(`
      ALTER TABLE units_of_measure
        ADD CONSTRAINT base_unit_id_tenant_fk FOREIGN KEY (tenant_id, base_unit_id)
        REFERENCES units_of_measure (tenant_id, id) ON DELETE RESTRICT
    `)
    this.schema.raw(`
      ALTER TABLE units_of_measure
        ADD CONSTRAINT units_precision_check CHECK ("precision" BETWEEN 0 AND 6),
        ADD CONSTRAINT units_factor_check CHECK (conversion_factor IS NULL OR conversion_factor > 0),
        ADD CONSTRAINT units_base_pair_check CHECK ((base_unit_id IS NULL) = (conversion_factor IS NULL)),
        ADD CONSTRAINT units_not_own_base CHECK (base_unit_id IS NULL OR base_unit_id <> id)
    `)

    createTenantTable(this, 'sequences', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('branch_id').nullable()
      table.string('document_type', 50).notNullable()
      table.string('series', 30).notNullable()
      table.string('period', 20).notNullable()
      table.string('prefix_template', 100).notNullable()
      table.bigInteger('next_value').notNullable().defaultTo(1)
      table.integer('padding').notNullable().defaultTo(6)
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'branch_id', 'organization_units')
    })
    this.schema.raw(`
      ALTER TABLE sequences
        ADD CONSTRAINT sequences_next_value_check CHECK (next_value >= 1),
        ADD CONSTRAINT sequences_padding_check CHECK (padding BETWEEN 1 AND 12)
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX sequences_scope_unique ON sequences
        (tenant_id, organization_id, COALESCE(branch_id, '${ZERO_UUID}'::uuid), document_type, series, period)
    `)

    for (const table of ['setting_values', 'tax_rates', 'units_of_measure', 'sequences']) {
      auditTable(this, table)
    }
  }

  async down() {
    dropTable(this, 'sequences')
    dropTable(this, 'units_of_measure')
    dropTable(this, 'tax_rates')
    this.schema.raw(`DROP FUNCTION IF EXISTS tax_rates_no_overlap()`)
    dropTable(this, 'setting_values')
  }
}
