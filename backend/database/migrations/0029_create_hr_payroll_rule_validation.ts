import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * IRT/INSS (Prompt 07, bloco 7.8): validade explícita das regras, confirmação das normas vigentes por uma pessoa (com
 * nota) e casos de teste oficiais (com fonte) que têm de passar para publicar. Depois de publicadas, as regras e os
 * casos não mudam (o trigger de `payroll_rule_sets` já protege a linha; aqui protege-se os casos). A confirmação é
 * exigida às regras publicadas daqui em diante (`NOT VALID`: as já publicadas, imutáveis, não são reescritas).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('payroll_rule_sets', (table) => {
      table.date('valid_to').nullable()
      table.uuid('confirmed_by').nullable()
      table.timestamp('confirmed_at', { useTz: true }).nullable()
      table.text('confirmation_note').nullable()
    })
    this.schema.raw(`ALTER TABLE payroll_rule_sets ADD CONSTRAINT payroll_rule_sets_validity_check
      CHECK (valid_to IS NULL OR valid_to >= valid_from)`)
    this.schema
      .raw(`ALTER TABLE payroll_rule_sets ADD CONSTRAINT payroll_rule_sets_confirmation_check
      CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)
        AND (confirmed_at IS NULL OR length(trim(confirmation_note)) >= 5)
        AND (status = 'DRAFT' OR confirmed_at IS NOT NULL)) NOT VALID`)

    createTenantTable(this, 'payroll_rule_test_cases', (table) => {
      table.uuid('rule_set_id').notNullable()
      table.integer('sequence').notNullable()
      table.string('description', 200).notNullable()
      table.text('source').notNullable()
      table.decimal('base_salary', 18, 2).notNullable()
      table.decimal('allowances_subject', 18, 2).notNullable().defaultTo(0)
      table.decimal('allowances_irt_only', 18, 2).notNullable().defaultTo(0)
      table.decimal('allowances_exempt', 18, 2).notNullable().defaultTo(0)
      table.decimal('expected_inss_employee', 18, 2).notNullable()
      table.decimal('expected_irt', 18, 2).notNullable()
      table.decimal('expected_inss_employer', 18, 2).nullable()
      table.decimal('expected_net', 18, 2).nullable()
      tenantForeignKey(table, 'rule_set_id', 'payroll_rule_sets', 'CASCADE')
      table.unique(['tenant_id', 'rule_set_id', 'sequence'], {
        indexName: 'payroll_rule_test_cases_sequence_unique',
      })
      table.check(`length(trim(source)) >= 5`, [], 'payroll_rule_test_cases_source_check')
      table.check(
        `base_salary >= 0 AND allowances_subject >= 0 AND allowances_irt_only >= 0 AND allowances_exempt >= 0`,
        [],
        'payroll_rule_test_cases_amounts_check'
      )
    })
    this.schema.raw(`CREATE TRIGGER payroll_rule_test_cases_frozen
      BEFORE INSERT OR UPDATE OR DELETE ON payroll_rule_test_cases
      FOR EACH ROW EXECUTE FUNCTION payroll_irt_brackets_frozen()`)
  }

  async down() {
    this.schema.dropTable('payroll_rule_test_cases')
    this.schema.raw(
      'ALTER TABLE payroll_rule_sets DROP CONSTRAINT payroll_rule_sets_confirmation_check'
    )
    this.schema.raw(
      'ALTER TABLE payroll_rule_sets DROP CONSTRAINT payroll_rule_sets_validity_check'
    )
    this.schema.alterTable('payroll_rule_sets', (table) => {
      table.dropColumn('valid_to')
      table.dropColumn('confirmed_by')
      table.dropColumn('confirmed_at')
      table.dropColumn('confirmation_note')
    })
  }
}
