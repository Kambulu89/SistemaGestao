import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, tenantForeignKey } from '#database/support/tables'

/**
 * Contabilidade analítica (Prompt 06, bloco 6.5). Camada separada do razão: as imputações dizem como o valor de uma
 * linha se reparte por centros de custo e dimensões (projecto, região, …) em percentagens que somam 100%; nunca criam
 * nem alteram movimentos contabilísticos, por isso podem ser corrigidas depois da contabilização (com auditoria).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'analytic_dimensions', (table) => {
      table.string('code', 30).notNullable()
      table.string('name', 120).notNullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      table.unique(['tenant_id', 'code'], { indexName: 'analytic_dimensions_code_unique' })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'analytic_dimensions_status_check')
    })
    createTenantTable(this, 'analytic_dimension_values', (table) => {
      table.uuid('dimension_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'dimension_id', 'analytic_dimensions')
      table.unique(['tenant_id', 'dimension_id', 'code'], {
        indexName: 'analytic_values_code_unique',
      })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'analytic_values_status_check')
    })
    // Para a FK composta (valor, dimensão): garante que o valor é mesmo da dimensão indicada.
    this.schema.raw(
      `ALTER TABLE analytic_dimension_values ADD CONSTRAINT analytic_values_dimension_unique UNIQUE (tenant_id, dimension_id, id)`
    )

    // Chaves de repartição reutilizáveis (por entidade legal, porque os centros de custo são da entidade).
    createTenantTable(this, 'allocation_keys', (table) => {
      table.uuid('legal_entity_id').notNullable()
      table.string('code', 30).notNullable()
      table.string('name', 160).notNullable()
      table.string('status', 12).notNullable().defaultTo('ACTIVE')
      tenantForeignKey(table, 'legal_entity_id', 'legal_entities')
      table.unique(['tenant_id', 'legal_entity_id', 'code'], {
        indexName: 'allocation_keys_code_unique',
      })
      table.check(`status IN ('ACTIVE','INACTIVE')`, [], 'allocation_keys_status_check')
    })

    // Imputações: pela chave (lançamento, n.º da linha), para não dependerem do id físico das linhas.
    for (const [table, owner, ownerTable] of [
      ['allocation_key_lines', 'key_id', 'allocation_keys'],
      ['journal_line_allocations', 'entry_id', 'journal_entries'],
    ] as const) {
      createTenantTable(this, table, (t) => {
        t.uuid(owner).notNullable()
        if (table === 'journal_line_allocations') t.smallint('line_no').notNullable()
        t.smallint('seq').notNullable()
        t.specificType('percent', 'numeric(7,4)').notNullable()
        t.uuid('cost_center_id').nullable()
        tenantForeignKey(t, owner, ownerTable, 'CASCADE')
        tenantForeignKey(t, 'cost_center_id', 'cost_centers')
        t.unique(
          table === 'journal_line_allocations'
            ? ['tenant_id', owner, 'line_no', 'seq']
            : ['tenant_id', owner, 'seq'],
          { indexName: `${table}_seq_unique` }
        )
        t.check('percent > 0 AND percent <= 100', [], `${table}_percent_check`)
      })
    }
    for (const [table, owner, ownerTable] of [
      ['allocation_key_line_values', 'key_line_id', 'allocation_key_lines'],
      ['journal_line_allocation_values', 'allocation_id', 'journal_line_allocations'],
    ] as const) {
      createTenantTable(this, table, (t) => {
        t.uuid(owner).notNullable()
        t.uuid('dimension_id').notNullable()
        t.uuid('value_id').notNullable()
        tenantForeignKey(t, owner, ownerTable, 'CASCADE')
        tenantForeignKey(t, 'dimension_id', 'analytic_dimensions')
        // Um valor por dimensão em cada imputação.
        t.unique(['tenant_id', owner, 'dimension_id'], { indexName: `${table}_dimension_unique` })
      })
      this.schema
        .raw(`ALTER TABLE ${table} ADD CONSTRAINT value_id_tenant_fk FOREIGN KEY (tenant_id, dimension_id, value_id)
        REFERENCES analytic_dimension_values (tenant_id, dimension_id, id) ON DELETE RESTRICT`)
    }
    this.schema.raw(
      'CREATE INDEX journal_line_allocations_entry_index ON journal_line_allocations (tenant_id, entry_id, line_no)'
    )
  }

  async down() {
    this.schema.dropTable('journal_line_allocation_values')
    this.schema.dropTable('allocation_key_line_values')
    this.schema.dropTable('journal_line_allocations')
    this.schema.dropTable('allocation_key_lines')
    this.schema.dropTable('allocation_keys')
    this.schema.dropTable('analytic_dimension_values')
    this.schema.dropTable('analytic_dimensions')
  }
}
