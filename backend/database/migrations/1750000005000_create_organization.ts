import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, dropTable, tenantForeignKey } from '#database/support/tenant_tables'

/**
 * Organização (C07): `organizations`, `organization_units` (árvore), `cost_centers` (árvore própria,
 * dimensão financeira), `team_members` e `membership_scopes` (C05/C06). Tudo de tenant.
 *
 * "Pai da mesma organização" é imposto pela **base de dados**: a FK do pai é
 * `(tenant_id, organization_id, parent_id) → (tenant_id, organization_id, id)`. Os ciclos não se
 * exprimem em FKs: são rejeitados pela aplicação sob um lock consultivo por tenant.
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'organizations', (table) => {
      table.string('code', 40).notNullable()
      table.string('legal_name', 200).notNullable()
      table.string('trade_name', 160).nullable()
      table.specificType('country_code', 'char(2)').notNullable()
      table.string('tax_id', 40).nullable()
      table.specificType('base_currency', 'char(3)').notNullable()
      table.integer('fiscal_year_start_month').notNullable().defaultTo(1)
      // Sem FK: `addresses` (C08) chega com Party.
      table.uuid('address_id').nullable()
      table.boolean('active').notNullable().defaultTo(true)
      table.unique(['tenant_id', 'code'], { indexName: 'organizations_tenant_code_unique' })
      table.check(
        'fiscal_year_start_month between 1 and 12',
        [],
        'organizations_fiscal_month_check'
      )
      table.check("country_code ~ '^[A-Z]{2}$'", [], 'organizations_country_check')
      table.check("base_currency ~ '^[A-Z]{3}$'", [], 'organizations_currency_check')
    })

    createTenantTable(this, 'organization_units', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('parent_id').nullable()
      table.string('code', 40).notNullable()
      table.string('name', 160).notNullable()
      table
        .enum('type', ['BRANCH', 'DEPARTMENT', 'SECTION', 'TEAM', 'OTHER'], {
          useNative: false,
          enumName: 'organization_units_type_check',
        })
        .notNullable()
        .defaultTo('OTHER')
      table.uuid('manager_membership_id').nullable()
      table.string('timezone', 64).nullable()
      table.boolean('active').notNullable().defaultTo(true)
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'manager_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'organization_id', 'code'], {
        indexName: 'organization_units_org_code_unique',
      })
      // Alvo da FK do pai: a unidade pai tem de ser da mesma organização.
      table.unique(['tenant_id', 'organization_id', 'id'], {
        indexName: 'organization_units_org_id_unique',
      })
      table.index(['tenant_id', 'parent_id'], 'organization_units_parent_index')
      table.check('parent_id IS NULL OR parent_id <> id', [], 'organization_units_not_own_parent')
    })
    this.schema.raw(`
      ALTER TABLE organization_units
        ADD CONSTRAINT organization_units_parent_fk
        FOREIGN KEY (tenant_id, organization_id, parent_id)
        REFERENCES organization_units (tenant_id, organization_id, id) ON DELETE RESTRICT
    `)

    createTenantTable(this, 'cost_centers', (table) => {
      table.uuid('organization_id').notNullable()
      table.uuid('parent_id').nullable()
      table.string('code', 40).notNullable()
      table.string('name', 160).notNullable()
      table.uuid('responsible_membership_id').nullable()
      table.boolean('active').notNullable().defaultTo(true)
      tenantForeignKey(table, 'organization_id', 'organizations')
      tenantForeignKey(table, 'responsible_membership_id', 'tenant_memberships')
      table.unique(['tenant_id', 'organization_id', 'code'], {
        indexName: 'cost_centers_org_code_unique',
      })
      table.unique(['tenant_id', 'organization_id', 'id'], {
        indexName: 'cost_centers_org_id_unique',
      })
      table.check('parent_id IS NULL OR parent_id <> id', [], 'cost_centers_not_own_parent')
    })
    this.schema.raw(`
      ALTER TABLE cost_centers
        ADD CONSTRAINT cost_centers_parent_fk
        FOREIGN KEY (tenant_id, organization_id, parent_id)
        REFERENCES cost_centers (tenant_id, organization_id, id) ON DELETE RESTRICT
    `)

    createTenantTable(this, 'team_members', (table) => {
      table.uuid('unit_id').notNullable()
      table.uuid('membership_id').notNullable()
      table.date('starts_on').notNullable()
      table.date('ends_on').nullable()
      table.string('role_label', 80).nullable()
      tenantForeignKey(table, 'unit_id', 'organization_units')
      tenantForeignKey(table, 'membership_id', 'tenant_memberships', { onDelete: 'CASCADE' })
      table.index(['tenant_id', 'unit_id'], 'team_members_unit_index')
      table.check('ends_on IS NULL OR ends_on >= starts_on', [], 'team_members_window_check')
    })

    createTenantTable(this, 'membership_scopes', (table) => {
      table.uuid('membership_id').notNullable()
      table.uuid('organization_id').notNullable()
      table.uuid('organization_unit_id').nullable()
      table.boolean('include_descendants').notNullable().defaultTo(false)
      tenantForeignKey(table, 'membership_id', 'tenant_memberships', { onDelete: 'CASCADE' })
      tenantForeignKey(table, 'organization_id', 'organizations')
      table.index(['tenant_id', 'membership_id'], 'membership_scopes_membership_index')
    })
    // A unidade do âmbito tem de pertencer à organização indicada.
    this.schema.raw(`
      ALTER TABLE membership_scopes
        ADD CONSTRAINT membership_scopes_unit_fk
        FOREIGN KEY (tenant_id, organization_id, organization_unit_id)
        REFERENCES organization_units (tenant_id, organization_id, id) ON DELETE CASCADE
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX membership_scopes_unique ON membership_scopes
        (tenant_id, membership_id, organization_id,
         COALESCE(organization_unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
    `)

    // Atribuições de papéis por unidade (criadas na 1.4 sem FK): agora a unidade existe e é do tenant.
    this.schema.raw(`
      ALTER TABLE role_assignments
        ADD CONSTRAINT role_assignments_unit_tenant_fk
        FOREIGN KEY (tenant_id, organization_unit_id)
        REFERENCES organization_units (tenant_id, id) ON DELETE RESTRICT
    `)
    this.schema.raw(`
      ALTER TABLE tenant_memberships
        ADD CONSTRAINT tenant_memberships_default_org_fk
        FOREIGN KEY (tenant_id, default_organization_id)
        REFERENCES organizations (tenant_id, id) ON DELETE RESTRICT
    `)
  }

  async down() {
    this.schema.raw(
      `ALTER TABLE tenant_memberships DROP CONSTRAINT IF EXISTS tenant_memberships_default_org_fk`
    )
    this.schema.raw(
      `ALTER TABLE role_assignments DROP CONSTRAINT IF EXISTS role_assignments_unit_tenant_fk`
    )
    dropTable(this, 'membership_scopes')
    dropTable(this, 'team_members')
    dropTable(this, 'cost_centers')
    dropTable(this, 'organization_units')
    dropTable(this, 'organizations')
  }
}
