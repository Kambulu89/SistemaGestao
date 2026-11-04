import { test } from '@japa/runner'
import {
  as,
  cleanDatabase,
  lastTokenFor,
  login,
  PASSWORD,
  signIn,
  tenantWithAdmin,
} from '#tests/support/fixtures'

test.group('membros | convites, recuperação e sessões', (group) => {
  group.each.setup(() => cleanDatabase())

  test('convite: conta nova, email de desenvolvimento, aceitação única e entrada', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await tenantWithAdmin('CONV')
    const s = await signIn(client, admin.email, tenant.id)
    const invited = await as(client, s).post('/api/v1/members/invitations', {
      email: 'Nova@Teste.Invalid',
      fullName: 'Nova',
    })
    invited.assertStatus(201)
    assert.equal(invited.body().data.delivery, 'SENT_DEV')
    assert.equal(invited.body().data.member.status, 'INVITED')
    // Antes de aceitar não entra (sem palavra-passe).
    ;(
      await client
        .post('/api/v1/auth/login')
        .json({ email: 'nova@teste.invalid', password: PASSWORD })
    ).assertStatus(401)
    const dup = await as(client, s).post('/api/v1/members/invitations', {
      email: 'nova@teste.invalid',
    })
    dup.assertStatus(409)

    const token = await lastTokenFor('nova@teste.invalid', 'INVITATION')
    const weak = await client
      .post('/api/v1/auth/invitations/accept')
      .json({ token, password: 'curta' })
    weak.assertStatus(422)
    const accepted = await client
      .post('/api/v1/auth/invitations/accept')
      .json({ token, password: PASSWORD })
    accepted.assertStatus(200)
    const again = await client
      .post('/api/v1/auth/invitations/accept')
      .json({ token, password: PASSWORD })
    again.assertStatus(400)
    again.assertBodyContains({ error: { code: 'TOKEN_INVALID' } })
    const { response } = await login(client, 'nova@teste.invalid')
    response.assertStatus(200)
    assert.deepInclude(response.body().data.tenants[0], { code: 'CONV', available: true })
  })

  test('um utilizador existente pode pertencer a duas empresas', async ({ client, assert }) => {
    const a = await tenantWithAdmin('PRIMEIRA')
    const b = await tenantWithAdmin('SEGUNDA')
    const sb = await signIn(client, b.admin.email, b.tenant.id)
    await as(client, sb).post('/api/v1/members/invitations', { email: a.admin.email })
    const token = await lastTokenFor(a.admin.email, 'INVITATION')
    // A conta já tem palavra-passe: a aceitação não a pede.
    ;(await client.post('/api/v1/auth/invitations/accept').json({ token })).assertStatus(200)
    const { response } = await login(client, a.admin.email)
    assert.sameMembers(
      response.body().data.tenants.map((t: any) => t.code),
      ['PRIMEIRA', 'SEGUNDA']
    )
  })

  test('recuperação: resposta genérica, token de uso único, sessões antigas terminadas', async ({
    client,
  }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const old = await signIn(client, admin.email, tenant.id)
    ;(
      await client.post('/api/v1/auth/password/forgot').json({ email: 'ninguem@teste.invalid' })
    ).assertStatus(202)
    ;(await client.post('/api/v1/auth/password/forgot').json({ email: admin.email })).assertStatus(
      202
    )
    const token = await lastTokenFor(admin.email, 'PASSWORD_RESET')
    const newPassword = 'uma-nova-frase-bem-longa'
    ;(
      await client.post('/api/v1/auth/password/reset').json({ token, password: newPassword })
    ).assertStatus(200)
    ;(
      await client.post('/api/v1/auth/password/reset').json({ token, password: newPassword })
    ).assertStatus(400)
    ;(await client.get('/api/v1/auth/me').header('cookie', old.cookie)).assertStatus(401)
    ;(
      await client.post('/api/v1/auth/login').json({ email: admin.email, password: PASSWORD })
    ).assertStatus(401)
    ;(
      await client.post('/api/v1/auth/login').json({ email: admin.email, password: newPassword })
    ).assertStatus(200)
  })

  test('sessões: lista as próprias e revoga uma', async ({ client, assert }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const first = await signIn(client, admin.email, tenant.id)
    const second = await signIn(client, admin.email, tenant.id)
    const list = await as(client, second).get('/api/v1/auth/sessions')
    list.assertStatus(200)
    assert.lengthOf(list.body().data, 2)
    const other = list.body().data.find((x: any) => !x.current)
    ;(await as(client, second).delete(`/api/v1/auth/sessions/${other.id}`)).assertStatus(200)
    ;(await client.get('/api/v1/auth/me').header('cookie', first.cookie)).assertStatus(401)
    ;(await client.get('/api/v1/auth/me').header('cookie', second.cookie)).assertStatus(200)
  })
})
