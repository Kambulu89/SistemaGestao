import { BaseSchema } from '@adonisjs/lucid/schema'
import { createTenantTable, dropTable, tenantForeignKey } from '#database/support/tenant_tables'

/**
 * Party (C08): identidade de negócio reutilizável (cliente, fornecedor, colaborador...), distinta do
 * `User`. "Exactamente um subtipo coerente com `kind`" é imposto pela base: cada subtipo tem a sua
 * própria coluna `kind` fixa e uma FK composta `(tenant_id, party_id, kind) → parties`.
 * As colunas `*_key` guardam a forma normalizada usada para detectar possíveis duplicados (nunca se
 * funde nada automaticamente).
 */
export default class extends BaseSchema {
  async up() {
    createTenantTable(this, 'parties', (table) => {
      table
        .enum('kind', ['PERSON', 'ORGANIZATION'], {
          useNative: false,
          enumName: 'parties_kind_check',
        })
        .notNullable()
      table.string('display_name', 200).notNullable()
      table
        .enum('status', ['ACTIVE', 'INACTIVE'], {
          useNative: false,
          enumName: 'parties_status_check',
        })
        .notNullable()
        .defaultTo('ACTIVE')
      table.string('external_reference', 100).nullable()
      table.unique(['tenant_id', 'id', 'kind'], { indexName: 'parties_tenant_id_kind_unique' })
      table.index(['tenant_id', 'display_name'], 'parties_display_name_index')
    })

    createTenantTable(this, 'people', (table) => {
      table.uuid('party_id').notNullable()
      table.string('kind', 12).notNullable().defaultTo('PERSON')
      table.string('given_names', 120).notNullable()
      table.string('family_name', 120).notNullable()
      table.date('birth_date').nullable()
      table.specificType('nationality', 'char(2)').nullable()
      table.string('identity_type', 30).nullable()
      table.string('identity_number', 60).nullable()
      table.string('identity_key', 100).nullable()
      table.unique(['tenant_id', 'party_id'], { indexName: 'people_party_unique' })
      table.index(['tenant_id', 'identity_key'], 'people_identity_key_index')
      table.check("kind = 'PERSON'", [], 'people_kind_check')
      table.check(
        "nationality IS NULL OR nationality ~ '^[A-Z]{2}$'",
        [],
        'people_nationality_check'
      )
    })
    this.schema.raw(`
      ALTER TABLE people ADD CONSTRAINT people_party_kind_fk
        FOREIGN KEY (tenant_id, party_id, kind) REFERENCES parties (tenant_id, id, kind) ON DELETE RESTRICT
    `)

    createTenantTable(this, 'organization_parties', (table) => {
      table.uuid('party_id').notNullable()
      table.string('kind', 12).notNullable().defaultTo('ORGANIZATION')
      table.string('legal_name', 200).notNullable()
      table.specificType('tax_country', 'char(2)').nullable()
      table.string('tax_id', 40).nullable()
      table.string('tax_key', 60).nullable()
      table.string('registration_number', 60).nullable()
      table.unique(['tenant_id', 'party_id'], { indexName: 'organization_parties_party_unique' })
      table.index(['tenant_id', 'tax_key'], 'organization_parties_tax_key_index')
      table.check("kind = 'ORGANIZATION'", [], 'organization_parties_kind_check')
      table.check(
        "tax_country IS NULL OR tax_country ~ '^[A-Z]{2}$'",
        [],
        'organization_parties_country_check'
      )
    })
    this.schema.raw(`
      ALTER TABLE organization_parties ADD CONSTRAINT organization_parties_party_kind_fk
        FOREIGN KEY (tenant_id, party_id, kind) REFERENCES parties (tenant_id, id, kind) ON DELETE RESTRICT
    `)

    createTenantTable(this, 'contacts', (table) => {
      table.uuid('party_id').notNullable()
      table
        .enum('type', ['EMAIL', 'PHONE', 'WEBSITE'], {
          useNative: false,
          enumName: 'contacts_type_check',
        })
        .notNullable()
      table.string('value', 254).notNullable()
      table.string('value_key', 254).notNullable()
      table.string('label', 60).nullable()
      table.boolean('is_primary').notNullable().defaultTo(false)
      table.timestamp('verified_at', { useTz: true }).nullable()
      tenantForeignKey(table, 'party_id', 'parties', { onDelete: 'CASCADE' })
      table.index(['tenant_id', 'party_id'], 'contacts_party_index')
      table.index(['tenant_id', 'type', 'value_key'], 'contacts_value_key_index')
    })
    // Um contacto principal por tipo e party.
    this.schema.raw(
      `CREATE UNIQUE INDEX contacts_one_primary ON contacts (tenant_id, party_id, type) WHERE is_primary`
    )

    createTenantTable(this, 'addresses', (table) => {
      table.uuid('party_id').notNullable()
      table
        .enum('type', ['BILLING', 'DELIVERY', 'OTHER'], {
          useNative: false,
          enumName: 'addresses_type_check',
        })
        .notNullable()
      table.string('line1', 200).notNullable()
      table.string('line2', 200).nullable()
      table.string('city', 100).notNullable()
      table.string('province', 100).nullable()
      table.specificType('country_code', 'char(2)').notNullable()
      table.string('postal_code', 20).nullable()
      table.boolean('is_primary').notNullable().defaultTo(false)
      tenantForeignKey(table, 'party_id', 'parties', { onDelete: 'CASCADE' })
      table.index(['tenant_id', 'party_id'], 'addresses_party_index')
      table.check("country_code ~ '^[A-Z]{2}$'", [], 'addresses_country_check')
    })
    this.schema.raw(
      `CREATE UNIQUE INDEX addresses_one_primary ON addresses (tenant_id, party_id, type) WHERE is_primary`
    )

    createTenantTable(this, 'party_relationships', (table) => {
      table.uuid('source_party_id').notNullable()
      table.uuid('target_party_id').notNullable()
      table.string('relationship_type', 50).notNullable()
      table.date('starts_on').nullable()
      table.date('ends_on').nullable()
      tenantForeignKey(table, 'source_party_id', 'parties', { onDelete: 'CASCADE' })
      tenantForeignKey(table, 'target_party_id', 'parties', { onDelete: 'CASCADE' })
      table.check('source_party_id <> target_party_id', [], 'party_relationships_distinct')
      table.check(
        'starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on',
        [],
        'party_relationships_window'
      )
      table.index(['tenant_id', 'source_party_id'], 'party_relationships_source_index')
      table.index(['tenant_id', 'target_party_id'], 'party_relationships_target_index')
    })
    this.schema.raw(`
      CREATE UNIQUE INDEX party_relationships_unique ON party_relationships
        (tenant_id, source_party_id, target_party_id, relationship_type)
    `)

    // A membership pode estar ligada a uma Person (vínculo User↔Pessoa opcional); uma Person, a uma só membership.
    this.schema.raw(`
      ALTER TABLE tenant_memberships ADD CONSTRAINT tenant_memberships_person_fk
        FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE RESTRICT
    `)
    this.schema.raw(`
      CREATE UNIQUE INDEX tenant_memberships_one_person ON tenant_memberships (tenant_id, person_id)
        WHERE person_id IS NOT NULL
    `)
  }

  async down() {
    this.schema.raw(`DROP INDEX IF EXISTS tenant_memberships_one_person`)
    this.schema.raw(
      `ALTER TABLE tenant_memberships DROP CONSTRAINT IF EXISTS tenant_memberships_person_fk`
    )
    dropTable(this, 'party_relationships')
    dropTable(this, 'addresses')
    dropTable(this, 'contacts')
    dropTable(this, 'organization_parties')
    dropTable(this, 'people')
    dropTable(this, 'parties')
  }
}
