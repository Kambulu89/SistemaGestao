import type { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Padrão obrigatório de criação de tabelas (o teste `schema_conformance` falha se não for seguido):
 *
 *  - Tabela de **tenant** (`createTenantTable`): `id` UUID, `tenant_id` com FK para `tenants`, colunas de auditoria
 *    (`created_at`, `updated_at`, `created_by`, `updated_by`), `version` para concorrência optimista, chave única
 *    `(tenant_id, id)` (alvo das FKs compostas que impedem ligar linhas de tenants diferentes) e RLS `ENABLE` + `FORCE`
 *    com política `USING` e `WITH CHECK` sobre `app_current_tenant_id()`.
 *  - Tabela **global** (`createGlobalTable`): sem `tenant_id` nem RLS; tem de constar de `PLATFORM_TABLES`.
 */
type SchemaBuilder = BaseSchema['schema']
export type TableBuilder = Parameters<Parameters<SchemaBuilder['createTable']>[1]>[0]

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`

export function createTenantTable(
  migration: BaseSchema,
  name: string,
  define: (table: TableBuilder) => void
) {
  migration.schema.createTable(name, (table) => {
    table.uuid('id').primary().defaultTo(migration.raw('gen_random_uuid()'))
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(migration.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(migration.now())
    table.uuid('created_by').nullable()
    table.uuid('updated_by').nullable()
    table.integer('version').notNullable().defaultTo(1)
    define(table)
    table.unique(['tenant_id', 'id'], { indexName: `${name}_tenant_id_id_unique` })
    table.index(['tenant_id'], `${name}_tenant_id_index`)
    table.check('version >= 1', [], `${name}_version_check`)
  })
  migration.schema.raw(`ALTER TABLE ${quote(name)} ENABLE ROW LEVEL SECURITY`)
  migration.schema.raw(`ALTER TABLE ${quote(name)} FORCE ROW LEVEL SECURITY`)
  migration.schema.raw(`
    CREATE POLICY ${quote(`${name}_tenant_isolation`)} ON ${quote(name)}
      USING (tenant_id = app_current_tenant_id())
      WITH CHECK (tenant_id = app_current_tenant_id())
  `)
}

export function createGlobalTable(
  migration: BaseSchema,
  name: string,
  define: (table: TableBuilder) => void
) {
  migration.schema.createTable(name, (table) => {
    table.uuid('id').primary().defaultTo(migration.raw('gen_random_uuid()'))
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(migration.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(migration.now())
    define(table)
  })
}

/**
 * FK **composta** `(tenant_id, coluna) → alvo(tenant_id, id)`: a base de dados recusa ligar uma linha de um tenant a uma
 * linha de outro. É a única forma permitida de relacionar duas tabelas de tenant.
 */
export function tenantForeignKey(
  table: TableBuilder,
  column: string,
  target: string,
  onDelete: 'RESTRICT' | 'CASCADE' | 'SET NULL' = 'RESTRICT'
) {
  table
    .foreign(['tenant_id', column], `${column}_tenant_fk`)
    .references(['tenant_id', 'id'])
    .inTable(target)
    .onDelete(onDelete)
}
