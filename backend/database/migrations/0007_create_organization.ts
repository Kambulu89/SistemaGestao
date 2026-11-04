import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Estrutura organizacional (bloco 3.4): entidades legais, filiais, departamentos (árvore), cargos e centros de custo
 * (árvore). Tudo por tenant com RLS e FKs compostas; códigos únicos; estado e vigência; sem eliminação física (inactivar).
 * Filiais, departamentos e centros de custo pertencem a uma entidade legal; os pais na árvore pertencem à mesma.
 */
export default class extends BaseSchema {
  async up() {
    const validity = (
      table: Parameters<Parameters<typeof createTenantTable>[2]>[0],
      name: string
    ) => {
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.date('valid_from').nullable()
      table.date('valid_to').nullable()
      table.check("status IN ('ACTIVE', 'INACTIVE')", [], `${name}_status_check`)
      table.check(
        'valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from',
        [],
        `${name}_validity_check`
      )
    }

    createTenantTable(this, 'legal_entities', (table) => {
      table.string('code', 30).notNullable()
      table.string('legal_name', 200).notNullable()
      table.string('trade_name', 200).nullable()
      table.string('tax_id', 30).notNullable()
      table.specificType('country_code', 'char(2)').notNullable()
      table.specificType('functional_currency', 'char(3)').notNullable()
      validity(table, 'legal_entities')
      table.unique(['tenant_id', 'code'], { indexName: 'legal_entities_code_unique' })
      table.unique(['tenant_id', 'country_code', 'tax_id'], {
        indexName: 'legal_entities_tax_id_unique',
      })
    })

    createTenantTable(this, 'branches', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('type', 20).notNullable().defaultTo('BRANCH')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      validity(table, 'branches')
      table.unique(['tenant_id', 'code'], { indexName: 'branches_code_unique' })
      table.index(['tenant_id', 'legal_entity_id'], 'branches_legal_entity_index')
      table.check(
        "type IN ('HEADQUARTERS', 'BRANCH', 'OFFICE', 'STORE', 'WAREHOUSE', 'PLANT')",
        [],
        'branches_type_check'
      )
    })

    createTenantTable(this, 'departments', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('branch_id').nullable()
      table.uuid('parent_id').nullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'branch_id', 'branches')
      validity(table, 'departments')
      table.unique(['tenant_id', 'code'], { indexName: 'departments_code_unique' })
      table.index(['tenant_id', 'parent_id'], 'departments_parent_index')
      table.check('parent_id IS NULL OR parent_id <> id', [], 'departments_not_own_parent_check')
    })
    this.schema
      .raw(`ALTER TABLE departments ADD CONSTRAINT parent_id_tenant_fk FOREIGN KEY (tenant_id, parent_id)
      REFERENCES departments (tenant_id, id) ON DELETE RESTRICT`)

    createTenantTable(this, 'positions', (table) => {
      table.uuid('department_id').nullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('job_family', 80).nullable()
      table.string('category', 80).nullable()
      table.smallint('level').nullable()
      table.text('description').nullable()
      tenantForeignKey(table, 'department_id', 'departments')
      validity(table, 'positions')
      table.unique(['tenant_id', 'code'], { indexName: 'positions_code_unique' })
      table.check('level IS NULL OR level BETWEEN 1 AND 20', [], 'positions_level_check')
    })

    createTenantTable(this, 'cost_centers', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.uuid('parent_id').nullable()
      table.uuid('department_id').nullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      tenantForeignKey(table, 'department_id', 'departments')
      validity(table, 'cost_centers')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], {
        indexName: 'cost_centers_code_unique',
      })
      table.index(['tenant_id', 'parent_id'], 'cost_centers_parent_index')
      table.check('parent_id IS NULL OR parent_id <> id', [], 'cost_centers_not_own_parent_check')
    })
    this.schema
      .raw(`ALTER TABLE cost_centers ADD CONSTRAINT parent_id_tenant_fk FOREIGN KEY (tenant_id, parent_id)
      REFERENCES cost_centers (tenant_id, id) ON DELETE RESTRICT`)

    // Âmbitos de perfis por entidade legal, filial e departamento: uma coluna por alvo, com FK composta e CHECK que
    // exige exactamente a coluna do âmbito indicado.
    this.schema.raw(`ALTER TABLE membership_roles DROP CONSTRAINT membership_roles_scope_check`)
    this.schema.raw(`ALTER TABLE membership_roles DROP CONSTRAINT membership_roles_unique`)
    this.schema.alterTable('membership_roles', (table) => {
      table.uuid('legal_entity_id').nullable()
      table.uuid('branch_id').nullable()
      table.uuid('department_id').nullable()
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities', 'CASCADE')
      tenantForeignKey(table, 'branch_id', 'branches', 'CASCADE')
      tenantForeignKey(table, 'department_id', 'departments', 'CASCADE')
    })
    this.schema.raw(`
      ALTER TABLE membership_roles ADD CONSTRAINT membership_roles_scope_check CHECK (
        (scope_type IN ('TENANT', 'OWN') AND legal_entity_id IS NULL AND branch_id IS NULL AND department_id IS NULL)
        OR (scope_type = 'LEGAL_ENTITY' AND legal_entity_id IS NOT NULL AND branch_id IS NULL AND department_id IS NULL)
        OR (scope_type = 'BRANCH' AND branch_id IS NOT NULL AND legal_entity_id IS NULL AND department_id IS NULL)
        OR (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL AND legal_entity_id IS NULL AND branch_id IS NULL))
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX membership_roles_unique ON membership_roles (tenant_id, membership_id, role_id, scope_type,
        coalesce(legal_entity_id, branch_id, department_id, '00000000-0000-0000-0000-000000000000'::uuid))
    `)
  }

  async down() {
    this.schema.raw(`DROP INDEX membership_roles_unique`)
    this.schema.raw(`DELETE FROM membership_roles WHERE scope_type NOT IN ('TENANT', 'OWN')`)
    this.schema.raw(`ALTER TABLE membership_roles DROP CONSTRAINT membership_roles_scope_check`)
    this.schema.alterTable('membership_roles', (table) => {
      table.dropForeign(['tenant_id', 'department_id'], 'department_id_tenant_fk')
      table.dropForeign(['tenant_id', 'branch_id'], 'branch_id_tenant_fk')
      table.dropForeign(['tenant_id', 'legal_entity_id'], 'legal_entity_id_tenant_fk')
      table.dropColumn('department_id')
      table.dropColumn('branch_id')
      table.dropColumn('legal_entity_id')
    })
    this.schema.raw(
      `ALTER TABLE membership_roles ADD CONSTRAINT membership_roles_scope_check CHECK (scope_type IN ('TENANT', 'OWN'))`
    )
    this.schema.raw(
      `ALTER TABLE membership_roles ADD CONSTRAINT membership_roles_unique UNIQUE (tenant_id, membership_id, role_id, scope_type)`
    )
    for (const table of [
      'cost_centers',
      'positions',
      'departments',
      'branches',
      'legal_entities',
    ]) {
      this.schema.dropTable(table)
    }
  }
}
