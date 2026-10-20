import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'

const currentTenant = async () => {
  const result = await db.connection('runtime').rawQuery('select app_current_tenant_id() as id')
  return result.rows[0].id as string | null
}

test.group('base de dados: fundação para o isolamento por tenant', () => {
  test('a conta de runtime não é superuser nem ignora a RLS', async ({ assert }) => {
    const result = await db
      .connection('runtime')
      .rawQuery(
        'select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user'
      )
    assert.deepEqual(result.rows[0], {
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    })
  })

  test('a conta de runtime não é dona das tabelas nem pode alterar a estrutura', async ({
    assert,
  }) => {
    const runtime = db.connection('runtime')
    await assert.rejects(() => runtime.rawQuery('create table intruso (id int)'))
    await assert.rejects(() => runtime.rawQuery('select * from adonis_schema'))
  })

  test('as migrations correm com a conta owner, que é distinta da de runtime', async ({
    assert,
  }) => {
    const owner = await db.connection('owner').rawQuery('select current_user as u')
    const runtime = await db.connection('runtime').rawQuery('select current_user as u')
    assert.notStrictEqual(owner.rows[0].u, runtime.rows[0].u)
  })

  test('sem contexto de tenant o acesso é negado (NULL)', async ({ assert }) => {
    assert.isNull(await currentTenant())
  })

  test('o tenant definido com set_config local só vale dentro da transacção', async ({
    assert,
  }) => {
    const trx = await db.connection('runtime').transaction()
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [TENANT_A])
    const inside = await trx.rawQuery('select app_current_tenant_id() as id')
    assert.strictEqual(inside.rows[0].id, TENANT_A)
    await trx.commit()

    assert.isNull(await currentTenant())
  })

  test('uma ligação reutilizada de A para B nunca herda o contexto anterior', async ({
    assert,
  }) => {
    // Pool com várias ligações: repetir força a reutilização de ligações já usadas por outro tenant.
    for (let i = 0; i < 20; i++) {
      const tenant = i % 2 === 0 ? TENANT_A : TENANT_B
      const trx = await db.connection('runtime').transaction()
      await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant])
      const current = await trx.rawQuery('select app_current_tenant_id() as id')
      assert.strictEqual(current.rows[0].id, tenant)
      await trx.rollback()
      assert.isNull(await currentTenant())
    }
  })

  test('um valor inválido no contexto falha em vez de ser aceite', async ({ assert }) => {
    const trx = await db.connection('runtime').transaction()
    await trx.rawQuery("select set_config('app.tenant_id', 'nao-e-um-uuid', true)")
    await assert.rejects(() => trx.rawQuery('select app_current_tenant_id()'))
    await trx.rollback()
  })
})
