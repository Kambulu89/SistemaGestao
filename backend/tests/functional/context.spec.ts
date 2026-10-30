import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import type { ApiResponse } from '@japa/api-client'
import {
  ChangeMembershipStatus,
  LucidMembershipDirectory,
  LucidMembershipStore,
} from '#core/membership/index'
import { LucidTenantDatabase, serviceTenantContext } from '#core/tenancy/index'
import {
  ChangeTenantStatus,
  LucidTenantStore,
  RegisterTenantDomain,
  VerifyTenantDomain,
} from '#platform/tenants/index'
import { ApiError } from '#core/http/api_error'
import { capture } from '#tests/support/capture'
import {
  PASSWORD,
  createActiveUser,
  deleteTestUsers,
  resetAuthState,
} from '#tests/support/auth_fixture'
import { addMember, createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'

const COOKIE = 'sg_session'

async function login(client: any, email: string) {
  const response = (await client
    .post('/api/v1/auth/login')
    .json({ email, password: PASSWORD })) as ApiResponse
  response.assertStatus(200)
  const header = response.headers()['set-cookie'] as string | string[]
  const raw = (Array.isArray(header) ? header : [header]).find((c) =>
    c.startsWith(`${COOKIE}=`)
  ) as string
  return `${COOKIE}=${raw.split(';')[0].split('=')[1]}`
}

const ctxRequest = (
  client: any,
  cookie: string,
  headers: Record<string, string | undefined> = {}
) => {
  const request = client.get('/api/v1/context').header('cookie', cookie)
  for (const [name, value] of Object.entries(headers)) {
    if (value) request.header(name, value)
  }
  return request as Promise<ApiResponse>
}

const membershipChanges = () =>
  new ChangeMembershipStatus(new LucidTenantDatabase(), new LucidMembershipStore())

test.group('contexto de tenant | resolução no servidor', (group) => {
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  test('exige sessão e um selector de tenant válido', async ({ client, assert }) => {
    const { email } = await createActiveUser()
    const cookie = await login(client, email)

    ;(await client.get('/api/v1/context')).assertStatus(401)

    const none = await ctxRequest(client, cookie)
    none.assertStatus(400)
    assert.strictEqual(none.body().error.code, 'TENANT_SELECTOR_REQUIRED')

    const bad = await ctxRequest(client, cookie, { 'x-tenant-id': 'nao-e-uuid' })
    assert.strictEqual(bad.body().error.code, 'TENANT_SELECTOR_INVALID')

    const tenant = await createActiveTenant()
    const both = await ctxRequest(client, cookie, {
      'x-tenant-id': tenant.id,
      'x-tenant-code': tenant.code,
    })
    both.assertStatus(400)
    assert.strictEqual(both.body().error.code, 'TENANT_SELECTOR_AMBIGUOUS')
  })

  test('devolve o contexto da membership activa (por id ou por código)', async ({
    client,
    assert,
  }) => {
    const { email, user } = await createActiveUser()
    const tenant = await createActiveTenant()
    const membership = await addMember(tenant, user.id)
    const cookie = await login(client, email)

    for (const headers of [
      { 'x-tenant-id': tenant.id },
      { 'x-tenant-code': tenant.code.toUpperCase() },
    ]) {
      const response = await ctxRequest(client, cookie, headers)
      response.assertStatus(200)
      const data = response.body().data
      assert.strictEqual(data.tenant.id, tenant.id)
      assert.strictEqual(data.membership.id, membership.id)
      assert.strictEqual(data.authorizationVersion, 1)
      assert.deepEqual(data.unitScope, { kind: 'UNITS', unitIds: [] })
      assert.strictEqual(data.user.email, email)
    }
  })

  test('sem membership, ou tenant inexistente, a resposta é igual (403) e não revela o tenant', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    const foreign = await createActiveTenant()
    const cookie = await login(client, email)

    const noMembership = await ctxRequest(client, cookie, { 'x-tenant-id': foreign.id })
    const missing = await ctxRequest(client, cookie, {
      'x-tenant-id': '00000000-0000-4000-8000-000000000000',
    })
    for (const r of [noMembership, missing]) {
      r.assertStatus(403)
      assert.strictEqual(r.body().error.code, 'TENANT_ACCESS_DENIED')
    }
    assert.strictEqual(noMembership.body().error.message, missing.body().error.message)
  })

  test('uma membership convidada ou terminada não dá acesso', async ({ client }) => {
    const { email, user } = await createActiveUser()
    const invited = await createActiveTenant()
    await addMember(invited, user.id, 'INVITED')
    const cookie = await login(client, email)
    ;(await ctxRequest(client, cookie, { 'x-tenant-id': invited.id })).assertStatus(403)
  })

  test('trocar de tenant dá o contexto do novo tenant, sem reutilizar o anterior', async ({
    client,
    assert,
  }) => {
    const both = await createActiveUser()
    const onlyA = await createActiveUser()
    const a = await createActiveTenant()
    const b = await createActiveTenant()
    const mA = await addMember(a, both.user.id)
    const mB = await addMember(b, both.user.id)
    await addMember(a, onlyA.user.id)

    const cookie = await login(client, both.email)
    const inA = (await ctxRequest(client, cookie, { 'x-tenant-id': a.id })).body().data
    const inB = (await ctxRequest(client, cookie, { 'x-tenant-id': b.id })).body().data
    assert.strictEqual(inA.membership.id, mA.id)
    assert.strictEqual(inB.membership.id, mB.id)
    assert.notStrictEqual(inA.tenant.id, inB.tenant.id)

    // Quem só pertence a A não consegue passar a B com o mesmo selector.
    const cookieA = await login(client, onlyA.email)
    ;(await ctxRequest(client, cookieA, { 'x-tenant-id': a.id })).assertStatus(200)
    ;(await ctxRequest(client, cookieA, { 'x-tenant-id': b.id })).assertStatus(403)
  })

  test('suspender a membership corta o acesso de imediato e incrementa a authorizationVersion', async ({
    client,
    assert,
  }) => {
    const { email, user } = await createActiveUser()
    const tenant = await createActiveTenant()
    await addMember(tenant, user.id)
    const cookie = await login(client, email)
    const headers = { 'x-tenant-id': tenant.id }
    ;(await ctxRequest(client, cookie, headers)).assertStatus(200)

    const ctx = serviceTenantContext(tenant.id, 'teste')
    const suspended = await membershipChanges().execute(ctx, {
      userId: user.id,
      status: 'SUSPENDED',
    })
    assert.strictEqual(suspended.authorizationVersion, 2)
    ;(await ctxRequest(client, cookie, headers)).assertStatus(403)

    await membershipChanges().execute(ctx, { userId: user.id, status: 'ACTIVE' })
    const back = await ctxRequest(client, cookie, headers)
    back.assertStatus(200)
    assert.strictEqual(back.body().data.authorizationVersion, 3)
  })

  test('as transições de membership seguem a máquina de estados (LEFT é terminal)', async ({
    assert,
  }) => {
    const { user } = await createActiveUser()
    const tenant = await createActiveTenant()
    await addMember(tenant, user.id)
    const ctx = serviceTenantContext(tenant.id, 'teste')

    await membershipChanges().execute(ctx, { userId: user.id, status: 'LEFT' })
    const error = (await capture(() =>
      membershipChanges().execute(ctx, { userId: user.id, status: 'ACTIVE' })
    )) as ApiError
    assert.strictEqual(error.status, 409)
    assert.strictEqual(error.code, 'INVALID_STATE_TRANSITION')

    const missing = (await capture(() =>
      membershipChanges().execute(ctx, {
        userId: '00000000-0000-4000-8000-000000000000',
        status: 'SUSPENDED',
      })
    )) as ApiError
    assert.strictEqual(missing.status, 404)
  })

  test('um utilizador não pode ter duas memberships no mesmo tenant (409)', async ({ assert }) => {
    const { user } = await createActiveUser()
    const tenant = await createActiveTenant()
    await addMember(tenant, user.id)
    const error = (await capture(() => addMember(tenant, user.id))) as ApiError
    assert.strictEqual(error.status, 409)
    assert.strictEqual(error.code, 'MEMBERSHIP_EXISTS')
  })

  test('tenant suspenso bloqueia o acesso por URL directa; o que não é membro continua a ver 403 genérico', async ({
    client,
    assert,
  }) => {
    const member = await createActiveUser()
    const outsider = await createActiveUser()
    const tenant = await createActiveTenant()
    await addMember(tenant, member.user.id)
    const cookie = await login(client, member.email)
    const outsiderCookie = await login(client, outsider.email)
    const headers = { 'x-tenant-id': tenant.id }

    const change = new ChangeTenantStatus(new LucidTenantStore())
    await change.execute(tenant.code, 'SUSPENDED')

    const blocked = await ctxRequest(client, cookie, headers)
    blocked.assertStatus(403)
    assert.strictEqual(blocked.body().error.code, 'TENANT_NOT_ACTIVE')
    const hidden = await ctxRequest(client, outsiderCookie, headers)
    assert.strictEqual(hidden.body().error.code, 'TENANT_ACCESS_DENIED')

    const list = await client.get('/api/v1/me/tenants').header('cookie', cookie)
    assert.deepEqual(
      list.body().data.map((t: any) => [t.code, t.status]),
      [[tenant.code, 'SUSPENDED']]
    )

    await change.execute(tenant.code, 'ACTIVE')
    ;(await ctxRequest(client, cookie, headers)).assertStatus(200)
  })

  test('GET /me/tenants lista só os tenants com membership activa', async ({ client, assert }) => {
    const { email, user } = await createActiveUser()
    const a = await createActiveTenant()
    const b = await createActiveTenant()
    const c = await createActiveTenant()
    await addMember(a, user.id)
    await addMember(b, user.id)
    await addMember(c, user.id, 'INVITED')

    const cookie = await login(client, email)
    const response = await client.get('/api/v1/me/tenants').header('cookie', cookie)
    response.assertStatus(200)
    assert.sameMembers(
      response.body().data.map((t: any) => t.id),
      [a.id, b.id]
    )
    ;(await client.get('/api/v1/me/tenants')).assertStatus(401)
  })

  test('o domínio verificado serve de selector; um não verificado é ignorado; conflito → 400', async ({
    client,
    assert,
  }) => {
    const { email, user } = await createActiveUser()
    const a = await createActiveTenant()
    const b = await createActiveTenant()
    await addMember(a, user.id)
    await addMember(b, user.id)
    const cookie = await login(client, email)

    const store = new LucidTenantStore()
    const hostname = `d-${a.code.replaceAll('_', '-')}.exemplo.test`
    const { verificationToken } = await new RegisterTenantDomain(store).execute({
      code: a.code,
      hostname,
    })

    // Por verificar: o Host não resolve nenhum tenant.
    const unverified = await ctxRequest(client, cookie, { host: hostname })
    assert.strictEqual(unverified.body().error.code, 'TENANT_SELECTOR_REQUIRED')

    await new VerifyTenantDomain(store).execute({ hostname, verificationToken })
    const viaHost = await ctxRequest(client, cookie, { host: hostname })
    viaHost.assertStatus(200)
    assert.strictEqual(viaHost.body().data.tenant.id, a.id)

    const mismatch = await ctxRequest(client, cookie, { 'host': hostname, 'x-tenant-id': b.id })
    mismatch.assertStatus(400)
    assert.strictEqual(mismatch.body().error.code, 'TENANT_SELECTOR_MISMATCH')
  })
})

test.group('memberships | RLS', (group) => {
  group.each.setup(() => async () => {
    await deleteTestTenants()
    await deleteTestUsers()
  })

  test('a leitura por utilizador só devolve as memberships dele', async ({ assert }) => {
    const u1 = await createActiveUser()
    const u2 = await createActiveUser()
    const a = await createActiveTenant()
    const b = await createActiveTenant()
    await addMember(a, u1.user.id)
    await addMember(b, u1.user.id)
    await addMember(a, u2.user.id)

    const directory = new LucidMembershipDirectory()
    const mine = await directory.listForUser(u1.user.id)
    assert.sameMembers(
      mine.map((m) => m.tenantId),
      [a.id, b.id]
    )
    assert.isTrue(mine.every((m) => m.userId === u1.user.id))
    assert.isNull(await directory.findForUser(u2.user.id, b.id))
  })

  test('sem contexto nenhuma linha é visível; app.user_id só dá leitura, nunca escrita', async ({
    assert,
  }) => {
    const u1 = await createActiveUser()
    const tenant = await createActiveTenant()
    await addMember(tenant, u1.user.id)
    const runtime = db.connection('runtime')

    const bare = await runtime.from('tenant_memberships').where('user_id', u1.user.id)
    assert.lengthOf(bare, 0)

    const written = await capture(async () => {
      await runtime.transaction(async (trx) => {
        await trx.rawQuery("select set_config('app.user_id', ?, true)", [u1.user.id])
        await trx.rawQuery(
          `insert into tenant_memberships (tenant_id, user_id, status) values (?, ?, 'ACTIVE')`,
          [tenant.id, u1.user.id]
        )
      })
    })
    assert.match(written.message, /row-level security|duplicate key/)

    const updated = await runtime.transaction(async (trx) => {
      await trx.rawQuery("select set_config('app.user_id', ?, true)", [u1.user.id])
      return trx.from('tenant_memberships').where('user_id', u1.user.id).update({ status: 'LEFT' })
    })
    assert.strictEqual(updated, 0)
  })
})
