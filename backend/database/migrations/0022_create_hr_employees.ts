import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Recursos humanos (Prompt 07, bloco 7.1): ficha do colaborador. O colaborador não é um utilizador: a ligação a uma
 * membership é opcional (self-service futuro). Entidade legal, filial, departamento, cargo e centro de custo vêm da
 * estrutura organizacional (sem cadastros duplicados). Os dados pessoais sensíveis ficam em colunas próprias e só a
 * API decide quem os vê (permissão `hr.sensitive` no âmbito do colaborador).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'employees', (table) => {
      table.string('code', 30).notNullable()
      table.string('full_name', 160).notNullable()
      table.string('work_email', 254).nullable()
      table.string('work_phone', 40).nullable()
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.uuid('department_id').nullable()
      table.uuid('position_id').nullable()
      table.uuid('manager_id').nullable()
      table.uuid('cost_center_id').nullable()
      table.uuid('membership_id').nullable()
      table.date('hire_date').notNullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      // Dados pessoais (sensíveis).
      table.date('birth_date').nullable()
      table.string('nationality', 2).nullable()
      table.string('id_document_type', 20).nullable()
      table.string('id_document_number', 40).nullable()
      table.date('id_document_expiry').nullable()
      table.string('tax_id', 30).nullable()
      table.string('social_security_number', 30).nullable()
      table.string('personal_email', 254).nullable()
      table.string('personal_phone', 40).nullable()
      table.string('address_line', 200).nullable()
      table.string('city', 80).nullable()
      table.string('province', 80).nullable()
      table.string('country_code', 2).nullable()
      table.string('emergency_name', 160).nullable()
      table.string('emergency_phone', 40).nullable()
      table.string('emergency_relation', 60).nullable()
      table.string('education_level', 40).nullable()
      table.string('education_field', 120).nullable()
      table.string('bank_name', 120).nullable()
      table.string('bank_iban', 34).nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      tenantForeignKey(table, 'department_id', 'departments')
      tenantForeignKey(table, 'position_id', 'positions')
      tenantForeignKey(table, 'cost_center_id', 'cost_centers')
      tenantForeignKey(table, 'membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'code'], { indexName: 'employees_code_unique' })
      table.index(['tenant_id', 'legal_entity_id'], 'employees_legal_entity_index')
      table.index(['tenant_id', 'department_id'], 'employees_department_index')
      table.index(['tenant_id', 'manager_id'], 'employees_manager_index')
      table.check(`status IN ('ACTIVE','SUSPENDED','TERMINATED')`, [], 'employees_status_check')
      table.check('manager_id IS NULL OR manager_id <> id', [], 'employees_not_own_manager_check')
      table.check(
        'birth_date IS NULL OR birth_date < hire_date',
        [],
        'employees_birth_before_hire_check'
      )
    })
    this.schema
      .raw(`ALTER TABLE employees ADD CONSTRAINT manager_id_tenant_fk FOREIGN KEY (tenant_id, manager_id)
      REFERENCES employees (tenant_id, id) ON DELETE RESTRICT`)
    // Identificadores pessoais únicos na empresa (quando preenchidos) e uma ficha por membership.
    this.schema.raw(`CREATE UNIQUE INDEX employees_tax_id_unique ON employees (tenant_id, tax_id)
      WHERE tax_id IS NOT NULL`)
    this.schema.raw(`CREATE UNIQUE INDEX employees_social_security_unique
      ON employees (tenant_id, social_security_number) WHERE social_security_number IS NOT NULL`)
    this.schema
      .raw(`CREATE UNIQUE INDEX employees_membership_unique ON employees (tenant_id, membership_id)
      WHERE membership_id IS NOT NULL`)
  }

  async down() {
    this.schema.dropTable('employees')
  }
}
