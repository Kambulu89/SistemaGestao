import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  auditTable,
  createTenantTable,
  dropTable,
  tenantForeignKey,
} from '#database/support/tenant_tables'

/**
 * Cargos e funções (Prompt 03 §7.4 e Prompt 05 §8). Um cargo é uma definição da organização, não uma pessoa: pode
 * existir sem ocupante e ser ocupado por vários colaboradores (o RH ligará os contratos a ele). Tem departamento por
 * omissão (unidade orgânica), cargo superior (hierarquia sem ciclos, rejeitados pela aplicação sob lock) e a descrição
 * funcional. As alterações ficam em `audit_logs` (antes/depois), que é o histórico das descrições.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'positions', (table) => {
      table.string('code', 40).notNullable()
      table.string('name', 160).notNullable()
      table.text('description').nullable()
      table.string('job_family', 80).nullable()
      table.string('category', 80).nullable()
      table.integer('hierarchy_level').nullable()
      table.uuid('department_id').nullable()
      table.uuid('parent_id').nullable()
      table.text('responsibilities').nullable()
      table.specificType('competencies', 'text[]').notNullable().defaultTo('{}')
      table.text('academic_requirements').nullable()
      table.string('recommended_experience', 200).nullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'department_id', 'organization_units')
      table.unique(['tenant_id', 'code'], { indexName: 'positions_tenant_code_unique' })
      table.index(['tenant_id', 'department_id'], 'positions_department_index')
      table.index(['tenant_id', 'parent_id'], 'positions_parent_index')
      table.check("status IN ('ACTIVE', 'INACTIVE')", [], 'positions_status_check')
      table.check(
        'hierarchy_level IS NULL OR hierarchy_level BETWEEN 1 AND 20',
        [],
        'positions_level_check'
      )
      table.check('parent_id IS NULL OR parent_id <> id', [], 'positions_not_own_parent')
      table.check("code ~ '^[A-Za-z0-9._-]{1,40}$'", [], 'positions_code_format')
    })
    // FK para a própria tabela: só depois de existir o único (tenant_id, id) que createTenantTable cria.
    this.schema.raw(`
      ALTER TABLE positions
        ADD CONSTRAINT parent_id_tenant_fk FOREIGN KEY (tenant_id, parent_id)
        REFERENCES positions (tenant_id, id) ON DELETE RESTRICT
    `)
    auditTable(this, 'positions')
  }

  async down() {
    dropTable(this, 'positions')
  }
}
