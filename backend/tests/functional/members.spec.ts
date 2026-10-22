import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { LucidTenantStore, ChangeTenantStatus } from '#platform/tenants/index'
import {
  createActiveUser,
  deleteTestUsers,
  mailbox,
  resetAuthState,
  uniqueEmail,
} from '#tests/support/auth_fixture'
import { addMember, createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, login, newActor } from '#tests/support/api_fixture'
import type { Tenant } from '#platform/tenants/index'

const store = new LucidTenantStore()
let counter = 0
const code = (prefix: string) => `${prefix}${process.pid}${counter++}`

async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const operator = await newActor(client, tenant)
  return { tenant, admin, operator, http: api(client, tenant, admin) }
}

/** Convida `email`, devolve o token que seguiu por email (a resposta nunca o contém). */
async function invite(
  http: ReturnType<typeof api>,
  email: string,
  extra: Record<string, unknown> = {}
) {
  const before = (await mailbox()).length
  const response = await http.post('/api/v1/invitations', { email, ...extra })
  response.assertStatus(201)
  const messages = await mailbox()
  return { invitation: response.body().data, token: messages[before].token as string }
}

/** Uma conta activa que ainda não pertence a nenhum tenant, com sessão iniciada. */
async function invitee(client: any) {
  const { user, email } = await createActiveUser()
  const session = await login(client, email)
  return { user, email, ...session }
}

const accept = (client: any, who: { cookie: string; csrf: string }, token: string) =>
  client
    .post('/api/v1/invitations/accept')
    .header('cookie', who.cookie)
    .header('x-csrf-token', who.csrf)
    .json({ token })

async function asTenantOwner<T = any>(tenant: Tenant, fn: (trx: any) => Promise<T>): Promise<T> {
  return db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenant.id])
    return fn(trx)
  })
}

test.group('membros | convites', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  test('exige member.invite; o token vai só por email e a resposta não o contém', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client)
    ;(
      await api(client, tenant, operator).post('/api/v1/invitations', { email: 'a@b.invalid' })
    ).assertStatus(403)
    ;(await api(client, tenant, operator).get('/api/v1/invitations')).assertStatus(403)

    const email = uniqueEmail('novo')
    const response = await http.post('/api/v1/invitations', { email: `  ${email.toUpperCase()} ` })
    response.assertStatus(201)
    assert.match(String(response.header('location')), /\/api\/v1\/invitations\/[0-9a-f-]{36}$/)
    assert.strictEqual(response.body().data.status, 'PENDING')
    assert.strictEqual(response.body().data.email, email)

    const [message] = await mailbox()
    assert.strictEqual(message.purpose, 'INVITATION')
    assert.strictEqual(message.to, email)
    assert.isTrue(message.token.startsWith(`${tenant.id}.`))
    assert.notInclude(JSON.stringify(response.body()), message.token)

    const rows = await asTenantOwner<{ token_hash: string }[]>(tenant, (trx) =>
      trx.from('invitations').select('token_hash')
    )
    assert.notInclude(
      rows.map((r: { token_hash: string }) => r.token_hash),
      message.token
    )
  })

  test('validações: email, prazo, papéis/unidades inexistentes, já membro, convite pendente', async ({
    client,
    assert,
  }) => {
    const { operator, http } = await setup(client)
    const email = uniqueEmail('v')
    ;(await http.post('/api/v1/invitations', { email: 'sem-arroba' })).assertStatus(422)
    ;(await http.post('/api/v1/invitations', { email, expiresInDays: 0 })).assertStatus(422)
    ;(await http.post('/api/v1/invitations', { email, expiresInDays: 31 })).assertStatus(422)

    const unknown = await http.post('/api/v1/invitations', {
      email,
      roleIds: ['00000000-0000-4000-8000-000000000000'],
      unitIds: ['00000000-0000-4000-8000-000000000001'],
    })
    unknown.assertStatus(422)
    assert.sameMembers(
      unknown.body().error.details.map((d: any) => d.path),
      ['roleIds[0]', 'unitIds[0]']
    )

    // Quem já é membro (activo ou suspenso) não precisa de convite.
    const member = await http.post('/api/v1/invitations', { email: operator.email })
    member.assertStatus(409)
    assert.strictEqual(member.body().error.code, 'ALREADY_MEMBER')

    const first = await invite(http, email)
    const second = await http.post('/api/v1/invitations', { email })
    second.assertStatus(409)
    assert.strictEqual(second.body().error.code, 'INVITATION_PENDING')

    // Depois de revogado, pode convidar-se de novo.
    ;(await http.post(`/api/v1/invitations/${first.invitation.id}/revoke`, {})).assertStatus(204)
    ;(await http.post('/api/v1/invitations', { email })).assertStatus(201)
  })

  test('aceitar: a mesma conta passa a ter membership, papéis e âmbito; o token é de uso único', async ({
    client,
    assert,
  }) => {
    const { tenant, admin, http } = await setup(client)
    const other = await createActiveTenant()
    const guest = await invitee(client)
    await addMember(other, guest.user.id) // já tem conta e pertence a outro tenant

    const org = (
      await http.post('/api/v1/organizations', {
        code: code('O'),
        legalName: 'Org',
        countryCode: 'AO',
        baseCurrency: 'AOA',
      })
    ).body().data
    const unit = (
      await http.post('/api/v1/organization-units', {
        organizationId: org.id,
        code: 'U1',
        name: 'U1',
      })
    ).body().data
    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor',
        name: 'Leitor',
        permissionCodes: ['member.read'],
      })
    ).body().data

    const { token, invitation } = await invite(http, guest.email, {
      roleIds: [role.id],
      unitIds: [unit.id],
    })
    const accepted = await accept(client, guest, token)
    accepted.assertStatus(200)
    assert.strictEqual(accepted.body().data.tenantId, tenant.id)

    const asGuest = api(client, tenant, { ...admin, cookie: guest.cookie, csrf: guest.csrf })
    const context = (await asGuest.get('/api/v1/context')).body().data
    assert.strictEqual(context.membership.id, accepted.body().data.membershipId)
    assert.strictEqual(context.user.id, guest.user.id, 'mantém a conta única')
    assert.deepEqual(
      context.permissions.map((p: any) => p.code),
      ['member.read']
    )
    assert.deepEqual(context.unitScope.unitIds, [unit.id])
    assert.isAbove(context.authorizationVersion, 1)
    ;(await asGuest.get('/api/v1/memberships')).assertStatus(200)

    const tenants = await client.get('/api/v1/me/tenants').header('cookie', guest.cookie)
    assert.lengthOf(tenants.body().data, 2)

    const listed = (await http.get('/api/v1/invitations')).body().data
    assert.strictEqual(listed.find((i: any) => i.id === invitation.id).status, 'ACCEPTED')

    const again = await accept(client, guest, token)
    again.assertStatus(400)
    assert.strictEqual(again.body().error.code, 'INVALID_OR_EXPIRED_TOKEN')
  })

  test('só quem tem o email do convite, com sessão e CSRF, e um token íntegro, aceita', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const other = await createActiveTenant()
    const guest = await invitee(client)
    const stranger = await invitee(client)
    const { token } = await invite(http, guest.email)

    ;(await client.post('/api/v1/invitations/accept').json({ token })).assertStatus(401)
    ;(
      await client.post('/api/v1/invitations/accept').header('cookie', guest.cookie).json({ token })
    ).assertStatus(403)

    const wrongAccount = await accept(client, stranger, token)
    wrongAccount.assertStatus(400)
    assert.strictEqual(wrongAccount.body().error.code, 'INVALID_OR_EXPIRED_TOKEN')

    const [, secret] = token.split('.')
    for (const bad of [
      'lixo',
      `${tenant.id}.${'x'.repeat(43)}`,
      `${other.id}.${secret}`,
      `${tenant.id}.${secret}extra`,
      `${tenant.id}.${secret}.x`,
    ]) {
      const response = await accept(client, guest, bad)
      assert.include([400, 422], response.status(), bad)
      if (response.status() === 400) {
        assert.strictEqual(response.body().error.code, 'INVALID_OR_EXPIRED_TOKEN')
      }
    }
    // O token certo continua válido: as tentativas falhadas não o gastaram.
    ;(await accept(client, guest, token)).assertStatus(200)
  })

  test('expirado ou revogado não se aceita; expirado liberta o email para novo convite', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const guest = await invitee(client)
    const first = await invite(http, guest.email)
    await asTenantOwner(tenant, (trx) =>
      trx.from('invitations').update({ expires_at: new Date(Date.now() - 1000) })
    )
    ;(await accept(client, guest, first.token)).assertStatus(400)
    const listed = (await http.get('/api/v1/invitations')).body().data
    assert.strictEqual(listed[0].status, 'EXPIRED')
    ;(await http.post(`/api/v1/invitations/${first.invitation.id}/revoke`, {})).assertStatus(409)

    const second = await invite(http, guest.email)
    ;(await http.post(`/api/v1/invitations/${second.invitation.id}/revoke`, {})).assertStatus(204)
    ;(await accept(client, guest, second.token)).assertStatus(400)
    ;(await http.post(`/api/v1/invitations/${second.invitation.id}/revoke`, {})).assertStatus(409)
    ;(
      await http.post('/api/v1/invitations/00000000-0000-4000-8000-000000000000/revoke', {})
    ).assertStatus(404)
  })

  test('um tenant suspenso não aceita convites', async ({ client }) => {
    const { tenant, http } = await setup(client)
    const guest = await invitee(client)
    const { token } = await invite(http, guest.email)
    await new ChangeTenantStatus(store).execute(tenant.code, 'SUSPENDED')
    ;(await accept(client, guest, token)).assertStatus(400)
    await new ChangeTenantStatus(store).execute(tenant.code, 'ACTIVE')
    ;(await accept(client, guest, token)).assertStatus(200)
  })

  test('quem saiu (LEFT) volta com novo convite e a mesma membership; suspenso não se auto-reactiva', async ({
    client,
    assert,
  }) => {
    const { tenant, admin, operator, http } = await setup(client)
    const list = (await http.get('/api/v1/memberships')).body().data
    const op = list.find((m: any) => m.id === operator.membershipId)

    ;(
      await http.patch(`/api/v1/memberships/${op.id}`, {
        status: 'SUSPENDED',
        expectedVersion: op.version,
      })
    ).assertStatus(200)
    const blocked = await http.post('/api/v1/invitations', { email: operator.email })
    assert.strictEqual(blocked.body().error.code, 'ALREADY_MEMBER')

    const suspended = (await http.get(`/api/v1/memberships/${op.id}`)).body().data
    ;(
      await http.patch(`/api/v1/memberships/${op.id}`, {
        status: 'LEFT',
        expectedVersion: suspended.version,
      })
    ).assertStatus(200)
    ;(await api(client, tenant, operator).get('/api/v1/context')).assertStatus(403)

    const { token } = await invite(http, operator.email)
    const session = await login(client, operator.email)
    const accepted = await accept(client, session, token)
    accepted.assertStatus(200)
    assert.strictEqual(accepted.body().data.membershipId, op.id)
    ;(await api(client, tenant, { ...admin, ...session }).get('/api/v1/context')).assertStatus(200)
  })

  test('quota de membros: recusa acima do limite e aceita ao subir o limite', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const guest = await invitee(client)
    const { token } = await invite(http, guest.email)

    await store.setMaxMembers(tenant.id, 2) // administrador + operador já ocupam 2
    const refused = await accept(client, guest, token)
    refused.assertStatus(409)
    assert.strictEqual(refused.body().error.code, 'MEMBER_QUOTA_EXCEEDED')

    await store.setMaxMembers(tenant.id, 3)
    ;(await accept(client, guest, token)).assertStatus(200)
  })

  test('sob concorrência: com um lugar livre só um dos dois convidados entra', async ({
    client,
  }) => {
    const { tenant, http } = await setup(client)
    const a = await invitee(client)
    const b = await invitee(client)
    const ta = (await invite(http, a.email)).token
    const tb = (await invite(http, b.email)).token
    await store.setMaxMembers(tenant.id, 3)

    const results = await Promise.all([accept(client, a, ta), accept(client, b, tb)])
    const statuses = results.map((r) => r.status()).sort()
    if (statuses.join() !== '200,409') throw new Error(`Estados inesperados: ${statuses.join()}`)
  })

  test('sob concorrência: o mesmo token só é aceite uma vez', async ({ client }) => {
    const { http } = await setup(client)
    const guest = await invitee(client)
    const { token } = await invite(http, guest.email)
    const results = await Promise.all([1, 2, 3].map(() => accept(client, guest, token)))
    const statuses = results.map((r) => r.status()).sort()
    if (statuses[0] !== 200 || statuses.slice(1).some((s) => ![400, 409].includes(s))) {
      throw new Error(`Estados inesperados: ${statuses.join()}`)
    }
    if (statuses.filter((s) => s === 200).length !== 1) throw new Error('Mais de uma aceitação')
  })

  test('a RLS esconde convites sem contexto de tenant', async ({ client, assert }) => {
    const { http } = await setup(client)
    await invite(http, uniqueEmail('rls'))
    assert.lengthOf(await db.connection('runtime').from('invitations'), 0)
  })
})

test.group('membros | gestão e último administrador', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  const member = async (http: ReturnType<typeof api>, id: string) =>
    (await http.get(`/api/v1/memberships/${id}`)).body().data

  test('lista com utilizador e papéis; exige member.read / member.manage', async ({
    client,
    assert,
  }) => {
    const { tenant, admin, operator, http } = await setup(client)
    ;(await api(client, tenant, operator).get('/api/v1/memberships')).assertStatus(403)
    ;(
      await api(client, tenant, operator).patch(`/api/v1/memberships/${admin.membershipId}`, {
        status: 'SUSPENDED',
        expectedVersion: 1,
      })
    ).assertStatus(403)

    const list = (await http.get('/api/v1/memberships')).body().data
    assert.lengthOf(list, 2)
    const a = list.find((m: any) => m.id === admin.membershipId)
    assert.strictEqual(a.email, admin.email)
    assert.deepEqual(
      a.roles.map((r: any) => r.roleCode),
      ['tenant_admin']
    )
    ;(await http.get('/api/v1/memberships/nao-e-uuid')).assertStatus(404)
  })

  test('suspender corta o acesso de imediato (só neste tenant); versão e transições controladas', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client)
    const other = await createActiveTenant()
    const op = await member(http, operator.membershipId)
    await addMember(other, operator.userId)
    ;(await api(client, tenant, operator).get('/api/v1/context')).assertStatus(200)

    const stale = await http.patch(`/api/v1/memberships/${op.id}`, {
      status: 'SUSPENDED',
      expectedVersion: op.version + 5,
    })
    stale.assertStatus(409)
    assert.strictEqual(stale.body().error.code, 'VERSION_CONFLICT')

    const suspended = await http.patch(`/api/v1/memberships/${op.id}`, {
      status: 'SUSPENDED',
      expectedVersion: op.version,
    })
    suspended.assertStatus(200)
    assert.isAbove(suspended.body().data.authorizationVersion, op.authorizationVersion)
    ;(await api(client, tenant, operator).get('/api/v1/context')).assertStatus(403)
    ;(await api(client, other, operator).get('/api/v1/context')).assertStatus(200)

    const invalid = await http.patch(`/api/v1/memberships/${op.id}`, {
      status: 'ACTIVE',
      expectedVersion: suspended.body().data.version,
    })
    invalid.assertStatus(200) // SUSPENDED → ACTIVE é válido
    const toLeft = await http.patch(`/api/v1/memberships/${op.id}`, {
      status: 'LEFT',
      expectedVersion: invalid.body().data.version,
    })
    toLeft.assertStatus(200)
    const back = await http.patch(`/api/v1/memberships/${op.id}`, {
      status: 'ACTIVE',
      expectedVersion: toLeft.body().data.version,
    })
    back.assertStatus(409)
    assert.strictEqual(back.body().error.code, 'INVALID_STATE_TRANSITION')
  })

  test('o último administrador activo não pode sair, ser suspenso nem perder o papel', async ({
    client,
    assert,
  }) => {
    const { tenant, admin, http } = await setup(client)
    const me = await member(http, admin.membershipId)

    for (const status of ['SUSPENDED', 'LEFT'] as const) {
      const refused = await http.patch(`/api/v1/memberships/${me.id}`, {
        status,
        expectedVersion: me.version,
      })
      refused.assertStatus(409)
      assert.strictEqual(refused.body().error.code, 'LAST_ADMIN')
    }
    ;(await api(client, tenant, admin).get('/api/v1/context')).assertStatus(200)
    assert.strictEqual((await member(http, me.id)).status, 'ACTIVE', 'a transacção foi anulada')

    const assignment = me.roles[0]
    const revoke = await http.delete(`/api/v1/role-assignments/${assignment.assignmentId}`)
    revoke.assertStatus(409)
    assert.strictEqual(revoke.body().error.code, 'LAST_ADMIN')

    const custom = (
      await http.post('/api/v1/roles', {
        code: 'gestor_iam',
        name: 'Gestor',
        permissionCodes: ['iam.manage'],
      })
    ).body().data

    // Com um segundo administrador, o primeiro já pode sair; o segundo passa a ser o último.
    const second = await newActor(client, tenant)
    const assigned = await http.post('/api/v1/role-assignments', {
      membershipId: second.membershipId,
      roleId: custom.id,
    })
    assigned.assertStatus(201)
    const left = await http.patch(`/api/v1/memberships/${me.id}`, {
      status: 'LEFT',
      expectedVersion: me.version,
    })
    left.assertStatus(200)

    const asSecond = api(client, tenant, second)
    const stripPermission = await asSecond.patch(`/api/v1/roles/${custom.id}`, {
      expectedVersion: custom.version,
      permissionCodes: ['iam.read'],
    })
    stripPermission.assertStatus(409)
    assert.strictEqual(stripPermission.body().error.code, 'LAST_ADMIN')
    ;(await asSecond.delete(`/api/v1/role-assignments/${assigned.body().data.id}`)).assertStatus(
      409
    )
  })

  test('sob concorrência dois administradores não se removem um ao outro', async ({ client }) => {
    const { tenant, admin, http } = await setup(client)
    const second = await newActor(client, tenant, true)
    const a = await member(http, admin.membershipId)
    const b = await member(http, second.membershipId)

    const results = await Promise.all([
      api(client, tenant, admin).patch(`/api/v1/memberships/${b.id}`, {
        status: 'SUSPENDED',
        expectedVersion: b.version,
      }),
      api(client, tenant, second).patch(`/api/v1/memberships/${a.id}`, {
        status: 'SUSPENDED',
        expectedVersion: a.version,
      }),
    ])
    const statuses = results.map((r) => r.status()).sort()
    if (statuses.join() !== '200,409') throw new Error(`Estados inesperados: ${statuses.join()}`)
    const [loser] = results.filter((r) => r.status() === 409)
    if (loser.body().error.code !== 'LAST_ADMIN') throw new Error('O 409 devia ser LAST_ADMIN')
  })

  test('preferências: lista fechada, valores validados e privadas de cada membro', async ({
    client,
    assert,
  }) => {
    const { tenant, admin, operator } = await setup(client)
    const mine = api(client, tenant, operator)
    const theirs = api(client, tenant, admin)

    ;(await mine.put('/api/v1/me/preferences/ui.theme', { value: 'dark' })).assertStatus(200)
    ;(
      await mine.put('/api/v1/me/preferences/ui.timezone', { value: 'Africa/Luanda' })
    ).assertStatus(200)
    ;(await mine.put('/api/v1/me/preferences/table.pageSize', { value: 25 })).assertStatus(200)
    const stored = (await mine.get('/api/v1/me/preferences')).body().data
    assert.deepEqual(stored, {
      'table.pageSize': 25,
      'ui.theme': 'dark',
      'ui.timezone': 'Africa/Luanda',
    })
    assert.deepEqual((await theirs.get('/api/v1/me/preferences')).body().data, {})

    for (const key of ['tax.rate', 'currency.base', 'security.maxSessions', 'ui.__proto__']) {
      const refused = await mine.put(`/api/v1/me/preferences/${key}`, { value: 'x' })
      refused.assertStatus(422)
      assert.strictEqual(refused.body().error.details[0].code, 'UNKNOWN_PREFERENCE', key)
    }
    for (const [key, value] of [
      ['ui.theme', 'neon'],
      ['ui.timezone', 'Marte/Olimpo'],
      ['notifications.email', 'sim'],
      ['table.pageSize', 5000],
      ['ui.locale', 'português'],
    ] as const) {
      const refused = await mine.put(`/api/v1/me/preferences/${key}`, { value })
      refused.assertStatus(422)
      assert.strictEqual(refused.body().error.details[0].code, 'INVALID_VALUE', key)
    }

    ;(await mine.delete('/api/v1/me/preferences/ui.theme')).assertStatus(204)
    ;(await mine.delete('/api/v1/me/preferences/ui.theme')).assertStatus(404)
    ;(await mine.put('/api/v1/me/preferences/ui.theme', { value: 'light' })).assertStatus(200)
    ;(await mine.put('/api/v1/me/preferences/ui.theme', { value: 'dark' })).assertStatus(200)
    assert.strictEqual((await mine.get('/api/v1/me/preferences')).body().data['ui.theme'], 'dark')
  })

  test('organização por omissão: tem de existir no tenant; pode limpar-se', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client)
    const other = await setup(client)
    const orgBody = { code: code('O'), legalName: 'Org', countryCode: 'AO', baseCurrency: 'AOA' }
    const org = (await http.post('/api/v1/organizations', orgBody)).body().data
    const foreign = (await other.http.post('/api/v1/organizations', orgBody)).body().data
    const mine = api(client, tenant, operator)

    const ok = await mine.put('/api/v1/me/default-organization', { organizationId: org.id })
    ok.assertStatus(200)
    assert.strictEqual(ok.body().data.defaultOrganizationId, org.id)
    ;(
      await mine.put('/api/v1/me/default-organization', { organizationId: foreign.id })
    ).assertStatus(422)
    const cleared = await mine.put('/api/v1/me/default-organization', { organizationId: null })
    assert.isNull(cleared.body().data.defaultOrganizationId)
  })
})
