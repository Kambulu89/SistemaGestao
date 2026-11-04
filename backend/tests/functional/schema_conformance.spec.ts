import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { FRAMEWORK_TABLES, PLATFORM_TABLES } from '#modules/tenancy/index'

test.group('esquema | isolamento por tenant', () => {
  test('toda a tabela é global enumerada ou de tenant com RLS forçada e política', async ({
    assert,
  }) => {
    const tables = await db.connection('owner').rawQuery(`
      select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             exists (select 1 from information_schema.columns k
                      where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'tenant_id') as has_tenant,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`)
    const problems: string[] = []
    for (const t of tables.rows as {
      name: string
      rls: boolean
      forced: boolean
      has_tenant: boolean
      policies: number
    }[]) {
      if (PLATFORM_TABLES.has(t.name) || FRAMEWORK_TABLES.has(t.name)) continue
      if (!t.has_tenant) problems.push(`${t.name}: sem tenant_id e não enumerada como global`)
      else if (!t.rls || !t.forced || t.policies === 0)
        problems.push(`${t.name}: RLS não forçada ou sem política`)
    }
    assert.deepEqual(problems, [])
  })
})
