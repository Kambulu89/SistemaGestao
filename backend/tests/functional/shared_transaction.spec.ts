import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { LucidTenantDatabase, LucidTenantScope, serviceTenantContext } from '#core/tenancy/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'

const txid = async (scope: unknown) =>
  (
    (await (scope as LucidTenantScope).trx.rawQuery('select txid_current()::text as id'))
      .rows[0] as {
      id: string
    }
  ).id

const insertExclusion = (scope: unknown, tenantId: string, value: string) =>
  (scope as LucidTenantScope).trx.rawQuery(
    `insert into marketing_exclusions (tenant_id, kind, value) values (?, 'EMAIL', ?)`,
    [tenantId, value]
  )

const exclusions = async (tenantId: string) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenantId])
    return (
      (await trx.rawQuery('select count(*)::int as n from marketing_exclusions')).rows[0] as {
        n: number
      }
    ).n
  })

test.group('núcleo | transacção partilhada entre casos de uso', (group) => {
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  test('um run aninhado do mesmo tenant e actor junta-se à transacção em curso', async ({
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const context = serviceTenantContext(tenant.id, 'teste')
    const uow = new LucidTenantDatabase()
    const [outer, inner] = await uow.run(async (scope) => {
      const before = await txid(scope)
      const nested = await uow.run(async (nestedScope) => txid(nestedScope), context)
      return [before, nested]
    }, context)
    assert.equal(inner, outer)
  })

  test('o que o run aninhado escreve reverte com a transacção exterior', async ({ assert }) => {
    const tenant = await createActiveTenant()
    const context = serviceTenantContext(tenant.id, 'teste')
    const uow = new LucidTenantDatabase()
    await assert.rejects(() =>
      uow.run(async (scope) => {
        await insertExclusion(scope, tenant.id, 'a@exemplo.invalid')
        await uow.run(async (nested) => {
          await insertExclusion(nested, tenant.id, 'b@exemplo.invalid')
        }, context)
        throw new Error('falha a meio')
      }, context)
    )
    assert.equal(await exclusions(tenant.id), 0)
    await uow.run(async (scope) => {
      await insertExclusion(scope, tenant.id, 'c@exemplo.invalid')
      await uow.run(async (nested) => {
        await insertExclusion(nested, tenant.id, 'd@exemplo.invalid')
      }, context)
    }, context)
    assert.equal(await exclusions(tenant.id), 2)
  })

  test('outro tenant ou outro actor nunca se junta à transacção', async ({ assert }) => {
    const a = await createActiveTenant()
    const b = await createActiveTenant()
    const uow = new LucidTenantDatabase()
    const contextA = serviceTenantContext(a.id, 'teste')
    const contextB = serviceTenantContext(b.id, 'teste')
    const [idA, idB] = await uow.run(async (scope) => {
      const outer = await txid(scope)
      const other = await uow.run(async (nested) => txid(nested), contextB)
      // O nested de outro tenant vê o seu tenant, não o do exterior.
      const seen = await uow.run(
        async (nested) =>
          (
            (
              await (nested as LucidTenantScope).trx.rawQuery(
                `select app_current_tenant_id()::text as t`
              )
            ).rows[0] as { t: string }
          ).t,
        contextB
      )
      assert.equal(seen, b.id)
      return [outer, other]
    }, contextA)
    assert.notEqual(idA, idB)
  })
})
