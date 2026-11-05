import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  addMembership,
  cleanDatabase,
  createTenant,
  createUser,
  login,
  signIn,
  tenantWithAdmin,
} from '#tests/support/fixtures'
import { runInTenant } from '#modules/tenancy/infrastructure/tenant_database'

test.group('tenancy | contexto e isolamento', (group) => {
  group.each.setup(() => cleanDatabase())

  test('o contexto vem da membership activa; o X-Tenant-Id sozinho não dá acesso', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const mine = await createTenant('MINHA')
    const other = await createTenant('OUTRA')
    const membershipId = await addMembership(mine.id, user.id)
    const { cookie } = await login(client, user.email)

    const ok = await client
      .get('/api/v1/context')
      .header('cookie', cookie)
      .header('x-tenant-id', mine.id)
    ok.assertStatus(200)
    assert.equal(ok.body().data.tenant.code, 'MINHA')
    assert.equal(ok.body().data.membershipId, membershipId)
    // Sem subscrição: nenhuma funcionalidade activa (negar por omissão).
    assert.equal(ok.body().data.subscriptionStatus, 'NONE')
    assert.deepEqual(ok.body().data.features, [])

    const foreign = await client
      .get('/api/v1/context')
      .header('cookie', cookie)
      .header('x-tenant-id', other.id)
    foreign.assertStatus(403)
    foreign.assertBodyContains({ error: { code: 'TENANT_ACCESS_DENIED' } })
    ;(await client.get('/api/v1/context').header('cookie', cookie)).assertStatus(400)
    ;(
      await client.get('/api/v1/context').header('cookie', cookie).header('x-tenant-id', 'abc')
    ).assertStatus(400)
  })

  test('membership suspensa ou tenant suspenso negam o acesso', async ({ client }) => {
    const user = await createUser()
    const suspendedLink = await createTenant('SUSPLINK')
    const suspendedTenant = await createTenant('SUSPTEN')
    await addMembership(suspendedLink.id, user.id, 'SUSPENDED')
    await addMembership(suspendedTenant.id, user.id)
    await db
      .connection('owner')
      .rawQuery(`update tenants set status = 'SUSPENDED' where id = ?`, [suspendedTenant.id])
    const { cookie } = await login(client, user.email)
    const a = await client
      .get('/api/v1/context')
      .header('cookie', cookie)
      .header('x-tenant-id', suspendedLink.id)
    a.assertStatus(403)
    const b = await client
      .get('/api/v1/context')
      .header('cookie', cookie)
      .header('x-tenant-id', suspendedTenant.id)
    b.assertStatus(403)
    b.assertBodyContains({ error: { code: 'TENANT_UNAVAILABLE' } })
  })

  test('RLS: a conta de runtime só vê e escreve linhas do tenant da transacção', async ({
    assert,
  }) => {
    const a = await createTenant('TA')
    const b = await createTenant('TB')
    const user = await createUser()
    const ma = await addMembership(a.id, user.id)
    await addMembership(b.id, user.id)
    const runtime = db.connection('runtime')

    // Sem contexto não vê nada.
    const none = await runtime.rawQuery('select count(*)::int as n from tenant_memberships')
    assert.equal(none.rows[0].n, 0)

    const ctx = { tenantId: a.id, userId: user.id, membershipId: ma, requestId: 'teste' }
    const seen = await runInTenant(
      ctx,
      async ({ trx }) =>
        (await trx.rawQuery('select tenant_id from tenant_memberships')).rows as {
          tenant_id: string
        }[]
    )
    assert.deepEqual(
      seen.map((r) => r.tenant_id),
      [a.id]
    )

    // Escrever uma linha de outro tenant é recusado pela política (WITH CHECK).
    let refused = ''
    await runInTenant(ctx, async ({ trx }) => {
      try {
        await trx.rawQuery('savepoint s')
        await trx.rawQuery(`update tenant_memberships set tenant_id = ? where tenant_id = ?`, [
          b.id,
          a.id,
        ])
      } catch (error) {
        refused = String((error as Error).message)
        await trx.rawQuery('rollback to savepoint s')
      }
    })
    assert.match(refused, /row-level security/)
  })

  test('a conta de runtime não é dona das tabelas nem contorna a RLS', async ({ assert }) => {
    const result = await db
      .connection('runtime')
      .rawQuery(`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`)
    assert.deepEqual(result.rows[0], { rolsuper: false, rolbypassrls: false })
    const owned = await db
      .connection('runtime')
      .rawQuery(
        `select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = current_user`
      )
    assert.equal(owned.rows[0].n, 0)
  })

  test('o contexto lista as funcionalidades activas da subscrição', async ({ client, assert }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    const ctx = await client
      .get('/api/v1/context')
      .header('cookie', s.cookie)
      .header('x-tenant-id', tenant.id)
    assert.equal(ctx.body().data.subscriptionStatus, 'ACTIVE')
    assert.includeMembers(
      ctx.body().data.features.map((f: any) => f.code),
      ['organization', 'approvals']
    )
  })
})
