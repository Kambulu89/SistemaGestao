import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  findTenancyViolations,
  type ViolationCode,
} from '#core/tenancy/infrastructure/schema_conformance'
import { createProbeSchema, dropProbeSchema } from '#tests/support/tenancy_fixture'

const owner = () => db.connection('owner')

/** Tabelas deliberadamente não conformes: controlos negativos que o verificador tem de apanhar. */
async function createBadSchema() {
  const q = (sql: string) => owner().rawQuery(sql)
  await q('DROP SCHEMA IF EXISTS probe_bad CASCADE')
  await q('CREATE SCHEMA probe_bad')
  const policy = (table: string, withCheck = true) =>
    q(`CREATE POLICY p ON probe_bad.${table} USING (tenant_id = app_current_tenant_id())
        ${withCheck ? 'WITH CHECK (tenant_id = app_current_tenant_id())' : ''}`)
  const conforming = async (table: string, extra = '') => {
    await q(`CREATE TABLE probe_bad.${table} (id uuid primary key, tenant_id uuid not null ${extra},
             unique (tenant_id, id))`)
    await q(`ALTER TABLE probe_bad.${table} ENABLE ROW LEVEL SECURITY`)
    await q(`ALTER TABLE probe_bad.${table} FORCE ROW LEVEL SECURITY`)
  }

  await q('CREATE TABLE probe_bad.no_tenant (id uuid primary key)')
  await q(
    'CREATE TABLE probe_bad.nullable_tenant (id uuid primary key, tenant_id uuid, unique (tenant_id, id))'
  )
  await q('ALTER TABLE probe_bad.nullable_tenant ENABLE ROW LEVEL SECURITY')
  await q('ALTER TABLE probe_bad.nullable_tenant FORCE ROW LEVEL SECURITY')
  await policy('nullable_tenant')

  await q(
    'CREATE TABLE probe_bad.rls_not_forced (id uuid primary key, tenant_id uuid not null, unique (tenant_id, id))'
  )
  await q('ALTER TABLE probe_bad.rls_not_forced ENABLE ROW LEVEL SECURITY')
  await policy('rls_not_forced')

  await conforming('policy_without_check')
  await policy('policy_without_check', false)

  await q('CREATE TABLE probe_bad.no_key (id uuid primary key, tenant_id uuid not null)')
  await q('ALTER TABLE probe_bad.no_key ENABLE ROW LEVEL SECURITY')
  await q('ALTER TABLE probe_bad.no_key FORCE ROW LEVEL SECURITY')
  await policy('no_key')

  await conforming('parent')
  await policy('parent')
  await conforming('plain_fk', 'references probe_bad.parent(id)')
  await policy('plain_fk')

  await conforming('ok')
  await policy('ok')
}

const dropBadSchema = () => owner().rawQuery('DROP SCHEMA IF EXISTS probe_bad CASCADE')

const codesByTable = (violations: { table: string; code: ViolationCode }[]) => {
  const result = new Map<string, Set<ViolationCode>>()
  for (const { table, code } of violations) {
    result.set(table, (result.get(table) ?? new Set()).add(code))
  }
  return result
}

test.group('conformidade do esquema com o isolamento por tenant', (group) => {
  group.setup(async () => {
    await createProbeSchema()
    await createBadSchema()
  })
  group.teardown(async () => {
    await dropProbeSchema()
    await dropBadSchema()
  })

  test('o esquema real cumpre todas as garantias (nenhuma tabela fora das regras)', async ({
    assert,
  }) => {
    assert.deepEqual(await findTenancyViolations(), [])
  })

  test('tabelas criadas com os helpers de migration são conformes', async ({ assert }) => {
    assert.deepEqual(await findTenancyViolations({ schemas: ['probe'] }), [])
  })

  test('detecta cada tipo de violação (controlos negativos)', async ({ assert }) => {
    const violations = await findTenancyViolations({ schemas: ['probe_bad'] })
    const byTable = codesByTable(violations)
    const expected: Record<string, ViolationCode[]> = {
      'probe_bad.no_tenant': [
        'MISSING_TENANT_ID',
        'RLS_NOT_ENABLED',
        'POLICY_MISSING',
        'MISSING_TENANT_ID_KEY',
      ],
      'probe_bad.nullable_tenant': ['TENANT_ID_NULLABLE'],
      'probe_bad.rls_not_forced': ['RLS_NOT_FORCED'],
      'probe_bad.policy_without_check': ['POLICY_WITHOUT_TENANT_CHECK'],
      'probe_bad.no_key': ['MISSING_TENANT_ID_KEY'],
      'probe_bad.plain_fk': ['FK_NOT_COMPOSITE'],
    }
    for (const [table, codes] of Object.entries(expected)) {
      const found = byTable.get(table)
      assert.isDefined(found, `${table} devia ter violações`)
      for (const code of codes) assert.isTrue(found!.has(code), `${table}: falta ${code}`)
    }
    // Tabelas conformes não geram violações.
    assert.isUndefined(byTable.get('probe_bad.ok'))
    assert.isUndefined(byTable.get('probe_bad.parent'))
  })

  test('uma tabela enumerada como global fica isenta; as restantes continuam a ser verificadas', async ({
    assert,
  }) => {
    const violations = await findTenancyViolations({
      schemas: ['probe_bad'],
      exempt: new Set(['probe_bad.no_tenant']),
    })
    assert.isFalse(violations.some((v) => v.table === 'probe_bad.no_tenant'))
    assert.isTrue(violations.some((v) => v.table === 'probe_bad.no_key'))
  })
})
