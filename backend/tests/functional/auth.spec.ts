import { test } from '@japa/runner'
import {
  addMembership,
  cleanDatabase,
  createTenant,
  createUser,
  login,
} from '#tests/support/fixtures'

test.group('identidade | sessão', (group) => {
  group.each.setup(() => cleanDatabase())

  test('login cria sessão em cookie HttpOnly e devolve as empresas do utilizador', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const tenant = await createTenant('ACME')
    await addMembership(tenant.id, user.id)
    const { response, cookie } = await login(client, user.email.toUpperCase())
    response.assertStatus(200)
    const setCookie = (response.headers()['set-cookie'] as string[]).join('\n')
    assert.match(setCookie, /sg_session=[^;]+;.*HttpOnly/i)
    assert.deepInclude(response.body().data.tenants[0], { code: 'ACME', available: true })
    const me = await client.get('/api/v1/auth/me').header('cookie', cookie)
    me.assertStatus(200)
    assert.equal(me.body().data.user.email, user.email)
    assert.notProperty(me.body().data.user, 'passwordHash')
  })

  test('credenciais erradas, conta desactivada e email inexistente dão a mesma resposta', async ({
    client,
  }) => {
    const user = await createUser()
    const disabled = await createUser({ status: 'DISABLED' })
    for (const body of [
      { email: user.email, password: 'errada-errada-errada' },
      { email: disabled.email, password: 'frase-de-teste-bem-longa' },
      { email: 'ninguem@teste.invalid', password: 'frase-de-teste-bem-longa' },
    ]) {
      const response = await client.post('/api/v1/auth/login').json(body)
      response.assertStatus(401)
      response.assertBodyContains({ error: { code: 'INVALID_CREDENTIALS' } })
    }
  })

  test('limita tentativas por email (429 com Retry-After)', async ({ client, assert }) => {
    const user = await createUser()
    let last
    for (let i = 0; i < 11; i++) {
      last = await client
        .post('/api/v1/auth/login')
        .json({ email: user.email, password: 'errada-errada-errada' })
    }
    last!.assertStatus(429)
    assert.isAbove(Number(last!.header('retry-after')), 0)
  })

  test('sem sessão dá 401; alterar dados sem CSRF dá 403; logout revoga a sessão', async ({
    client,
  }) => {
    const user = await createUser()
    ;(await client.get('/api/v1/auth/me')).assertStatus(401)
    const { cookie, xsrf } = await login(client, user.email)
    const noCsrf = await client.post('/api/v1/auth/logout').header('cookie', cookie)
    noCsrf.assertStatus(403)
    noCsrf.assertBodyContains({ error: { code: 'CSRF_INVALID' } })
    const wrong = await client
      .post('/api/v1/auth/logout')
      .header('cookie', cookie)
      .header('x-xsrf-token', 'x')
    wrong.assertStatus(403)
    const out = await client
      .post('/api/v1/auth/logout')
      .header('cookie', cookie)
      .header('x-xsrf-token', xsrf)
    out.assertStatus(200)
    ;(await client.get('/api/v1/auth/me').header('cookie', cookie)).assertStatus(401)
  })
})
