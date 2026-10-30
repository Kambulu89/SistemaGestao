import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import type { ApiResponse } from '@japa/api-client'
import { authServices } from '#core/auth/index'
import {
  ORIGIN,
  PASSWORD,
  createActiveUser,
  deleteTestUsers,
  mailbox,
  resetAuthState,
  uniqueEmail,
} from '#tests/support/auth_fixture'

const COOKIE_NAME = 'sg_session'

function setCookie(response: ApiResponse): string {
  const header = response.headers()['set-cookie'] as string | string[] | undefined
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  return cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? ''
}

const cookieValue = (response: ApiResponse) => setCookie(response).split(';')[0].split('=')[1]

async function login(client: any, email: string, password = PASSWORD) {
  const response = await client.post('/api/v1/auth/login').json({ email, password })
  return response as ApiResponse
}

/** Inicia sessão e devolve o cookie e o token CSRF para pedidos autenticados. */
async function session(client: any, email: string) {
  const response = await login(client, email)
  response.assertStatus(200)
  return {
    cookie: `${COOKIE_NAME}=${cookieValue(response)}`,
    csrf: response.body().data.csrfToken as string,
    response,
  }
}

test.group('auth | início e fim de sessão', (group) => {
  group.each.setup(async () => {
    await resetAuthState()
    return () => deleteTestUsers()
  })

  test('login devolve cookie opaco HttpOnly + SameSite e nunca expõe o hash', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    const response = await login(client, email.toUpperCase())

    response.assertStatus(200)
    const cookie = setCookie(response)
    assert.match(cookie, /HttpOnly/i)
    assert.match(cookie, /SameSite=Lax/i)
    assert.match(cookie, /Path=\//)
    assert.isAbove(cookieValue(response).length, 40)
    assert.deepEqual(Object.keys(response.body().data.user).sort(), [
      'displayName',
      'email',
      'id',
      'locale',
    ])
    assert.notInclude(JSON.stringify(response.body()), 'password')
    assert.notInclude(JSON.stringify(response.body()), cookieValue(response))
  })

  test('o token da sessão não é guardado em claro', async ({ client, assert }) => {
    const { email } = await createActiveUser()
    const response = await login(client, email)
    const rows = await db.connection('owner').from('auth_sessions').select('token_hash')
    assert.notInclude(
      rows.map((r) => r.token_hash),
      cookieValue(response)
    )
  })

  test('credenciais inválidas são indistinguíveis (utilizador inexistente, palavra-passe errada, conta pendente)', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    const pending = uniqueEmail('pending')
    await authServices().createUser.execute({ email: pending, displayName: 'P' })

    const results = [
      await login(client, uniqueEmail('naoexiste')),
      await login(client, email, 'palavra-passe-errada-123'),
      await login(client, pending, PASSWORD),
    ]
    for (const r of results) {
      r.assertStatus(401)
      assert.strictEqual(r.body().error.code, 'INVALID_CREDENTIALS')
      assert.strictEqual(r.body().error.message, results[0].body().error.message)
      assert.isEmpty(setCookie(r))
    }
  })

  test('excesso de tentativas devolve 429 com Retry-After, mesmo com a palavra-passe certa depois', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    for (let i = 0; i < 5; i++) (await login(client, email, 'errada-errada-123')).assertStatus(401)

    const blocked = await login(client, email, PASSWORD)
    blocked.assertStatus(429)
    assert.strictEqual(blocked.body().error.code, 'RATE_LIMITED')
    assert.isAbove(Number(blocked.header('retry-after')), 0)
  })

  test('um login com êxito repõe o contador da conta', async ({ client }) => {
    const { email } = await createActiveUser()
    for (let i = 0; i < 4; i++) (await login(client, email, 'errada-errada-123')).assertStatus(401)
    ;(await login(client, email)).assertStatus(200)
    for (let i = 0; i < 4; i++) (await login(client, email, 'errada-errada-123')).assertStatus(401)
  })

  test('corpo inválido devolve 422 no formato comum', async ({ client, assert }) => {
    const response = await client.post('/api/v1/auth/login').json({ email: 'a@b.pt' })
    response.assertStatus(422)
    assert.strictEqual(response.body().error.code, 'VALIDATION_ERROR')
    assert.strictEqual(response.body().error.details[0].path, 'password')
  })

  test('/me exige sessão; com cookie devolve o utilizador e o token CSRF', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    ;(await client.get('/api/v1/me')).assertStatus(401)
    ;(await client.get('/api/v1/me').header('cookie', `${COOKIE_NAME}=inventado`)).assertStatus(401)

    const { cookie, csrf } = await session(client, email)
    const me = await client.get('/api/v1/me').header('cookie', cookie)
    me.assertStatus(200)
    assert.strictEqual(me.body().data.user.email, email)
    assert.strictEqual(me.body().data.csrfToken, csrf)
  })

  test('logout exige CSRF e invalida a sessão para os pedidos seguintes', async ({ client }) => {
    const { email } = await createActiveUser()
    const { cookie, csrf } = await session(client, email)

    const noCsrf = await client.post('/api/v1/auth/logout').header('cookie', cookie)
    noCsrf.assertStatus(403)
    noCsrf.assertBodyContains({ error: { code: 'CSRF_TOKEN_INVALID' } })
    ;(
      await client.post('/api/v1/auth/logout').header('cookie', cookie).header('x-csrf-token', 'x')
    ).assertStatus(403)
    ;(await client.get('/api/v1/me').header('cookie', cookie)).assertStatus(200)

    ;(
      await client.post('/api/v1/auth/logout').header('cookie', cookie).header('x-csrf-token', csrf)
    ).assertStatus(204)
    ;(await client.get('/api/v1/me').header('cookie', cookie)).assertStatus(401)
  })

  test('o token CSRF de uma sessão não serve noutra', async ({ client }) => {
    const { email } = await createActiveUser()
    const a = await session(client, email)
    const b = await session(client, email)
    ;(
      await client
        .post('/api/v1/auth/logout')
        .header('cookie', a.cookie)
        .header('x-csrf-token', b.csrf)
    ).assertStatus(403)
  })

  test('uma sessão expirada deixa de funcionar', async ({ client }) => {
    const { email } = await createActiveUser()
    const { cookie } = await session(client, email)
    await db
      .connection('owner')
      .from('auth_sessions')
      .update({ expires_at: new Date(Date.now() - 1000) })
    ;(await client.get('/api/v1/me').header('cookie', cookie)).assertStatus(401)
  })

  test('uma conta bloqueada perde o acesso das sessões existentes', async ({ client }) => {
    const { email } = await createActiveUser()
    const { cookie } = await session(client, email)
    await db.connection('owner').from('users').where('email', email).update({ status: 'BLOCKED' })
    ;(await client.get('/api/v1/me').header('cookie', cookie)).assertStatus(401)
  })

  test('uma origem de browser não permitida é rejeitada nas escritas', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    const bad = await client
      .post('/api/v1/auth/login')
      .header('origin', 'https://atacante.example')
      .json({ email, password: PASSWORD })
    bad.assertStatus(403)
    assert.strictEqual(bad.body().error.code, 'ORIGIN_NOT_ALLOWED')

    const good = await client
      .post('/api/v1/auth/login')
      .header('origin', ORIGIN)
      .json({ email, password: PASSWORD })
    good.assertStatus(200)
  })
})

test.group('auth | sessões activas', (group) => {
  group.each.setup(async () => {
    await resetAuthState()
    return () => deleteTestUsers()
  })

  test('lista só as sessões do próprio utilizador e marca a actual', async ({ client, assert }) => {
    const { email } = await createActiveUser()
    const other = await createActiveUser()
    const a = await session(client, email)
    await session(client, email)
    await session(client, other.email)

    const list = await client.get('/api/v1/me/sessions').header('cookie', a.cookie)
    list.assertStatus(200)
    assert.lengthOf(list.body().data, 2)
    assert.lengthOf(
      list.body().data.filter((s: any) => s.current),
      1
    )
  })

  test('revogar uma sessão própria corta-a; a de outro utilizador devolve 404', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    const other = await createActiveUser()
    const a = await session(client, email)
    const b = await session(client, email)
    const o = await session(client, other.email)

    const listB = await client.get('/api/v1/me/sessions').header('cookie', b.cookie)
    const target = listB.body().data.find((s: any) => !s.current).id as string
    const foreign = (await client.get('/api/v1/me/sessions').header('cookie', o.cookie)).body()
      .data[0].id as string

    const denied = await client
      .delete(`/api/v1/me/sessions/${foreign}`)
      .header('cookie', a.cookie)
      .header('x-csrf-token', a.csrf)
    denied.assertStatus(404)
    assert.strictEqual(denied.body().error.code, 'NOT_FOUND')
    ;(
      await client
        .delete('/api/v1/me/sessions/nao-e-uuid')
        .header('cookie', a.cookie)
        .header('x-csrf-token', a.csrf)
    ).assertStatus(404)
    ;(await client.get('/api/v1/me').header('cookie', o.cookie)).assertStatus(200)

    ;(
      await client
        .delete(`/api/v1/me/sessions/${target}`)
        .header('cookie', a.cookie)
        .header('x-csrf-token', a.csrf)
    ).assertStatus(204)
    // A sessão `a` (a que foi revogada ou a outra) deixa de funcionar; a outra continua.
    const statuses = [
      (await client.get('/api/v1/me').header('cookie', a.cookie)).status(),
      (await client.get('/api/v1/me').header('cookie', b.cookie)).status(),
    ].sort()
    assert.deepEqual(statuses, [200, 401])
  })

  test('alterar a palavra-passe exige a actual, aplica a política e revoga as outras sessões', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    const a = await session(client, email)
    const b = await session(client, email)
    const url = '/api/v1/me/password'

    const wrong = await client
      .post(url)
      .header('cookie', a.cookie)
      .header('x-csrf-token', a.csrf)
      .json({ currentPassword: 'errada-errada-123', newPassword: 'nova-frase-bem-longa-1' })
    wrong.assertStatus(403)
    assert.strictEqual(wrong.body().error.code, 'REAUTHENTICATION_FAILED')

    const weak = await client
      .post(url)
      .header('cookie', a.cookie)
      .header('x-csrf-token', a.csrf)
      .json({ currentPassword: PASSWORD, newPassword: 'curta' })
    weak.assertStatus(422)
    assert.strictEqual(weak.body().error.details[0].path, 'newPassword')

    ;(
      await client
        .post(url)
        .header('cookie', a.cookie)
        .header('x-csrf-token', a.csrf)
        .json({ currentPassword: PASSWORD, newPassword: 'nova-frase-bem-longa-1' })
    ).assertStatus(204)

    ;(await client.get('/api/v1/me').header('cookie', a.cookie)).assertStatus(200)
    ;(await client.get('/api/v1/me').header('cookie', b.cookie)).assertStatus(401)
    ;(await login(client, email, PASSWORD)).assertStatus(401)
    ;(await login(client, email, 'nova-frase-bem-longa-1')).assertStatus(200)
  })
})

test.group('auth | recuperação de palavra-passe e verificação de email', (group) => {
  group.each.setup(async () => {
    await resetAuthState()
    return () => deleteTestUsers()
  })

  const forgot = (client: any, email: string) =>
    client.post('/api/v1/auth/forgot-password').json({ email }) as Promise<ApiResponse>
  const reset = (client: any, token: string, newPassword: string) =>
    client.post('/api/v1/auth/reset-password').json({ token, newPassword }) as Promise<ApiResponse>

  test('o pedido responde igual exista ou não a conta, e só envia mensagem a contas activas', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    const known = await forgot(client, email)
    const unknown = await forgot(client, uniqueEmail('naoexiste'))

    known.assertStatus(202)
    unknown.assertStatus(202)
    assert.deepEqual(known.body().data, unknown.body().data)

    const messages = await mailbox()
    assert.lengthOf(messages, 1)
    assert.strictEqual(messages[0].to, email)
    assert.strictEqual(messages[0].purpose, 'RESET_PASSWORD')
  })

  test('o token é de uso único, revoga todas as sessões e muda a palavra-passe', async ({
    client,
    assert,
  }) => {
    const { email } = await createActiveUser()
    const a = await session(client, email)
    await forgot(client, email)
    const [{ token }] = await mailbox()

    ;(await reset(client, token, 'palavra-nova-bem-longa-9')).assertStatus(204)
    ;(await client.get('/api/v1/me').header('cookie', a.cookie)).assertStatus(401)
    ;(await login(client, email, PASSWORD)).assertStatus(401)
    ;(await login(client, email, 'palavra-nova-bem-longa-9')).assertStatus(200)

    const again = await reset(client, token, 'outra-palavra-bem-longa-9')
    again.assertStatus(400)
    assert.strictEqual(again.body().error.code, 'INVALID_OR_EXPIRED_TOKEN')
  })

  test('sob concorrência só um pedido consome o token', async ({ client }) => {
    const { email } = await createActiveUser()
    await forgot(client, email)
    const [{ token }] = await mailbox()

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => reset(client, token, `palavra-concorrente-${n}-xyz`))
    )
    const statuses = results.map((r) => r.status()).sort()
    ;[204, 400, 400, 400].forEach((expected, i) => {
      if (statuses[i] !== expected) throw new Error(`Estados inesperados: ${statuses.join(',')}`)
    })
  })

  test('um token expirado, inventado ou de outro fim falha', async ({ client, assert }) => {
    const { email } = await createActiveUser()
    await forgot(client, email)
    const [{ token }] = await mailbox()
    await db
      .connection('owner')
      .from('one_time_tokens')
      .update({ expires_at: new Date(Date.now() - 1000) })

    for (const t of [token, 'x'.repeat(43)]) {
      const r = await reset(client, t, 'palavra-nova-bem-longa-9')
      r.assertStatus(400)
      assert.strictEqual(r.body().error.code, 'INVALID_OR_EXPIRED_TOKEN')
    }
    const verify = await client.post('/api/v1/auth/verify-email').json({ token })
    verify.assertStatus(400)
  })

  test('uma palavra-passe fraca é rejeitada sem gastar o token', async ({ client }) => {
    const { email } = await createActiveUser()
    await forgot(client, email)
    const [{ token }] = await mailbox()

    ;(await reset(client, token, 'curta')).assertStatus(422)
    ;(await reset(client, token, 'palavra-nova-bem-longa-9')).assertStatus(204)
  })

  test('um novo pedido invalida o token anterior', async ({ client }) => {
    const { email } = await createActiveUser()
    await forgot(client, email)
    await forgot(client, email)
    const [first, second] = await mailbox()

    ;(await reset(client, first.token, 'palavra-nova-bem-longa-9')).assertStatus(400)
    ;(await reset(client, second.token, 'palavra-nova-bem-longa-9')).assertStatus(204)
  })

  test('o limite por IP devolve 429 e o por conta é silencioso', async ({ client }) => {
    const { email } = await createActiveUser()
    for (let i = 0; i < 5; i++) (await forgot(client, email)).assertStatus(202)
    ;(await forgot(client, uniqueEmail('x'))).assertStatus(202)
    for (let i = 0; i < 4; i++) (await forgot(client, uniqueEmail('y'))).assertStatus(202)
    ;(await forgot(client, uniqueEmail('z'))).assertStatus(429)
  })

  test('a verificação de email activa a conta pendente uma só vez', async ({ client, assert }) => {
    const email = uniqueEmail('pendente')
    await authServices().createUser.execute({ email, displayName: 'Pendente' })
    // Antes de verificar não há sessão possível.
    ;(await login(client, email, PASSWORD)).assertStatus(401)

    const [{ token, purpose }] = await mailbox()
    assert.strictEqual(purpose, 'VERIFY_EMAIL')
    ;(await client.post('/api/v1/auth/verify-email').json({ token })).assertStatus(204)
    ;(await client.post('/api/v1/auth/verify-email').json({ token })).assertStatus(400)

    const user = await authServices().users.findByEmail(email)
    assert.strictEqual(user?.status, 'ACTIVE')
    assert.isNotNull(user?.emailVerifiedAt)
  })

  test('criar uma conta com email repetido devolve 409 (mesmo com maiúsculas)', async ({
    assert,
  }) => {
    const { email } = await createActiveUser()
    try {
      await authServices().createUser.execute({
        email: email.toUpperCase(),
        displayName: 'Repetido',
        password: PASSWORD,
        verified: true,
      })
      assert.fail('devia falhar')
    } catch (error) {
      assert.strictEqual((error as any).status, 409)
      assert.strictEqual((error as any).code, 'EMAIL_ALREADY_REGISTERED')
    }
  })
})
