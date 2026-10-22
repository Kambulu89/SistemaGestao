import type { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Padrão de criação de tabelas, para que **nenhuma** migration de tabela de tenant se esqueça das
 * garantias de isolamento (spec §1.1, §9.1 e §10.1):
 *
 *  - colunas base B: `id`, `tenant_id`, `created_at`, `updated_at`, `created_by_membership_id`,
 *    `updated_by_membership_id`, `version`;
 *  - chave única `(tenant_id, id)`: alvo das FKs compostas que impedem ligações entre tenants;
 *  - RLS com `ENABLE` **e** `FORCE` (aplica-se também à dona da tabela) e política `USING` + `WITH CHECK`;
 *  - índice a começar por `tenant_id`.
 *
 * Tabelas globais (G) usam `createGlobalTable` e têm de constar de `PLATFORM_TABLES` (o teste de
 * conformidade do esquema falha para qualquer tabela que não seja de tenant nem esteja enumerada).
 */
type SchemaBuilder = BaseSchema['schema']
type TableBuilder = Parameters<Parameters<SchemaBuilder['createTable']>[1]>[0]

export interface TenantTableOptions {
  /** Esquema PostgreSQL (por omissão o actual). */
  schemaName?: string
  /**
   * Tabela dos tenants, para a FK de `tenant_id`. Por omissão `tenants`; `null` apenas em fixtures de
   * teste em que ainda não existe.
   */
  tenantsTable?: string | null
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`
const qualified = (name: string, schemaName?: string) =>
  schemaName ? `${quote(schemaName)}.${quote(name)}` : quote(name)

/** Cria uma tabela de tenant com as colunas base, a chave `(tenant_id, id)` e a RLS forçada. */
export function createTenantTable(
  migration: BaseSchema,
  name: string,
  define: (table: TableBuilder) => void,
  options: TenantTableOptions = {}
) {
  const { schemaName, tenantsTable = 'tenants' } = options
  const builder = schemaName ? migration.schema.withSchema(schemaName) : migration.schema

  builder.createTable(name, (table) => {
    table.uuid('id').primary().defaultTo(migration.raw('gen_random_uuid()'))
    const tenantId = table.uuid('tenant_id').notNullable()
    if (tenantsTable) tenantId.references('id').inTable(tenantsTable).onDelete('RESTRICT')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(migration.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(migration.now())
    table.uuid('created_by_membership_id').nullable()
    table.uuid('updated_by_membership_id').nullable()
    table.integer('version').notNullable().defaultTo(1)

    define(table)

    table.unique(['tenant_id', 'id'], { indexName: `${name}_tenant_id_id_unique` })
    table.index(['tenant_id'], `${name}_tenant_id_index`)
    table.check('version >= 1', [], `${name}_version_check`)
  })

  const target = qualified(name, schemaName)
  migration.schema.raw(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY`)
  migration.schema.raw(`ALTER TABLE ${target} FORCE ROW LEVEL SECURITY`)
  migration.schema.raw(`
    CREATE POLICY ${quote(`${name}_tenant`)} ON ${target}
      USING (tenant_id = app_current_tenant_id())
      WITH CHECK (tenant_id = app_current_tenant_id())
  `)
}

/**
 * Cria uma tabela global (G): `id`, `created_at`, `updated_at`, `version`, **sem** `tenant_id` nem RLS.
 * Tem de ser acrescentada a `PLATFORM_TABLES`; só o plano de controlo da plataforma lhe acede.
 */
export function createGlobalTable(
  migration: BaseSchema,
  name: string,
  define: (table: TableBuilder) => void,
  options: Pick<TenantTableOptions, 'schemaName'> = {}
) {
  const builder = options.schemaName
    ? migration.schema.withSchema(options.schemaName)
    : migration.schema
  builder.createTable(name, (table) => {
    table.uuid('id').primary().defaultTo(migration.raw('gen_random_uuid()'))
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(migration.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(migration.now())
    table.integer('version').notNullable().defaultTo(1)
    define(table)
  })
}

/**
 * FK **composta** `(tenant_id, coluna) → alvo(tenant_id, id)`: a base de dados rejeita uma linha de um
 * tenant que aponte para uma linha de outro. É a única forma permitida de ligar duas tabelas de tenant.
 */
export function tenantForeignKey(
  table: TableBuilder,
  column: string,
  targetTable: string,
  options: { onDelete?: 'RESTRICT' | 'CASCADE'; targetSchema?: string } = {}
) {
  const target = options.targetSchema ? `${options.targetSchema}.${targetTable}` : targetTable
  table
    .foreign(['tenant_id', column], `${column}_tenant_fk`)
    .references(['tenant_id', 'id'])
    .inTable(target)
    .onDelete(options.onDelete ?? 'RESTRICT')
}

/** Remove uma tabela criada com os helpers acima. */
export function dropTable(migration: BaseSchema, name: string, schemaName?: string) {
  migration.schema.raw(`DROP TABLE IF EXISTS ${qualified(name, schemaName)} CASCADE`)
}

/**
 * Liga uma tabela de tenant à auditoria: cada INSERT/UPDATE/DELETE grava uma linha imutável em
 * `audit_logs` **na mesma transacção** (trigger `audit_row_change`). `redact` lista as colunas cujo
 * valor nunca entra na auditoria (aparece como `[REDACTED]`): segredos, hashes e dados sensíveis.
 * Toda a tabela de tenant tem de usar isto ou constar de `AUDIT_EXEMPT_TABLES` (verificado por teste).
 */
export function auditTable(migration: BaseSchema, name: string, redact: readonly string[] = []) {
  const args = redact.map((column) => `'${column.replaceAll("'", "''")}'`).join(', ')
  migration.schema.raw(`
    CREATE TRIGGER ${quote(`${name}_audit`)}
      AFTER INSERT OR UPDATE OR DELETE ON ${quote(name)}
      FOR EACH ROW EXECUTE FUNCTION audit_row_change(${args})
  `)
}

/** Remove a auditoria de uma tabela (usado no `down` das migrations). */
export function unauditTable(migration: BaseSchema, name: string) {
  migration.schema.raw(`DROP TRIGGER IF EXISTS ${quote(`${name}_audit`)} ON ${quote(name)}`)
}
