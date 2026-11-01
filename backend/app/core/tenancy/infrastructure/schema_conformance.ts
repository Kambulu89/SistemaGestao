import db from '@adonisjs/lucid/services/db'
import { FRAMEWORK_TABLES, PLATFORM_TABLES } from '#core/tenancy/domain/platform_tables'

export type ViolationCode =
  | 'MISSING_TENANT_ID'
  | 'TENANT_ID_NULLABLE'
  | 'RLS_NOT_ENABLED'
  | 'RLS_NOT_FORCED'
  | 'POLICY_MISSING'
  | 'POLICY_WITHOUT_TENANT_CHECK'
  | 'MISSING_TENANT_ID_KEY'
  | 'FK_NOT_COMPOSITE'

export interface TenancyViolation {
  table: string
  code: ViolationCode
  message: string
}

export interface ConformanceOptions {
  /** Esquemas a verificar (por omissão `public`). */
  schemas?: string[]
  /** Tabelas globais permitidas (por omissão `PLATFORM_TABLES` + tabelas do framework). */
  exempt?: ReadonlySet<string>
  /** Ligação com permissão de ler o catálogo (por omissão `owner`). */
  connection?: string
}

type Connection = ReturnType<typeof db.connection>

async function rows<T>(connection: Connection, sql: string, bindings: unknown[]): Promise<T[]> {
  const result = await connection.rawQuery(sql, bindings as never)
  return result.rows as T[]
}

const DEFAULT_EXEMPT: ReadonlySet<string> = new Set([...PLATFORM_TABLES, ...FRAMEWORK_TABLES])

/**
 * Verifica no catálogo do PostgreSQL que **toda** a tabela que não esteja enumerada como global
 * cumpre as garantias de isolamento: `tenant_id` obrigatório, RLS activa **e forçada**, política com
 * `USING` e `WITH CHECK` baseada em `app_current_tenant_id()`, chave única `(tenant_id, id)` e FKs
 * para outras tabelas de tenant sempre compostas. Devolve a lista de violações (vazia = conforme).
 */
export async function findTenancyViolations(
  options: ConformanceOptions = {}
): Promise<TenancyViolation[]> {
  const schemas = options.schemas ?? ['public']
  const exempt = options.exempt ?? DEFAULT_EXEMPT
  const connection = db.connection(options.connection ?? 'owner')
  const violations: TenancyViolation[] = []

  const tables = await rows<{ schema: string; name: string; rls: boolean; forced: boolean }>(
    connection,
    `select n.nspname as schema, c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname = any(?::text[])
      order by n.nspname, c.relname`,
    [schemas]
  )

  const tenantTables = tables.filter((t) => !exempt.has(`${t.schema}.${t.name}`))
  const tenantTableNames = new Set(tenantTables.map((t) => `${t.schema}.${t.name}`))

  for (const table of tenantTables) {
    const qualified = `${table.schema}.${table.name}`
    const quotedName = `"${table.schema}"."${table.name}"`
    const add = (code: ViolationCode, message: string) =>
      violations.push({ table: qualified, code, message })

    const [tenantColumn] = await rows<{ not_null: boolean }>(
      connection,
      `select a.attnotnull as not_null from pg_attribute a
        where a.attrelid = ?::regclass and a.attname = 'tenant_id' and not a.attisdropped`,
      [quotedName]
    )
    if (!tenantColumn) {
      add('MISSING_TENANT_ID', 'Tabela sem tenant_id que não está enumerada como global.')
    } else if (!tenantColumn.not_null) {
      add('TENANT_ID_NULLABLE', 'tenant_id tem de ser NOT NULL.')
    }

    if (!table.rls) add('RLS_NOT_ENABLED', 'RLS não está activa (ENABLE ROW LEVEL SECURITY).')
    else if (!table.forced) add('RLS_NOT_FORCED', 'RLS não é forçada (FORCE ROW LEVEL SECURITY).')

    const policies = await rows<{ qual: string | null; with_check: string | null }>(
      connection,
      `select qual, with_check from pg_policies where schemaname = ? and tablename = ?`,
      [table.schema, table.name]
    )
    if (policies.length === 0) {
      add('POLICY_MISSING', 'Nenhuma política RLS.')
    } else if (
      !policies.some(
        (p) =>
          p.qual?.includes('app_current_tenant_id') &&
          p.with_check?.includes('app_current_tenant_id')
      )
    ) {
      add(
        'POLICY_WITHOUT_TENANT_CHECK',
        'Nenhuma política com USING e WITH CHECK baseados em app_current_tenant_id().'
      )
    }

    const [key] = await rows<{ present: boolean }>(
      connection,
      `select exists (
         select 1 from pg_index i
          where i.indrelid = ?::regclass and i.indisunique
            and (select array_agg(a.attname::text order by k.ord)
                   from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
                = array['tenant_id', 'id']
       ) as present`,
      [quotedName]
    )
    if (!key.present) {
      add('MISSING_TENANT_ID_KEY', 'Falta a chave única (tenant_id, id), alvo das FKs compostas.')
    }

    const foreignKeys = await rows<{
      name: string
      target: string
      columns: string[]
      ref_columns: string[]
    }>(
      connection,
      `select con.conname as name,
              tn.nspname || '.' || tgt.relname as target,
              (select array_agg(a.attname::text order by k.ord)
                 from unnest(con.conkey) with ordinality as k(attnum, ord)
                 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns,
              (select array_agg(a.attname::text order by k.ord)
                 from unnest(con.confkey) with ordinality as k(attnum, ord)
                 join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as ref_columns
         from pg_constraint con
         join pg_class tgt on tgt.oid = con.confrelid
         join pg_namespace tn on tn.oid = tgt.relnamespace
        where con.contype = 'f' and con.conrelid = ?::regclass`,
      [quotedName]
    )
    for (const fk of foreignKeys) {
      if (!tenantTableNames.has(fk.target)) continue // FK para tabela global (ex.: tenants)
      if (!fk.columns.includes('tenant_id') || !fk.ref_columns.includes('tenant_id')) {
        add(
          'FK_NOT_COMPOSITE',
          `A FK "${fk.name}" para ${fk.target} não é composta (tenant_id, …): permitiria ligar tenants diferentes.`
        )
      }
    }
  }

  return violations
}
