import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'

const account = {
  fullName: 'Maria Silva',
  email: 'maria@exemplo.invalid',
  password: 'segredo-longo',
  passwordConfirmation: 'segredo-longo',
}

test.group('autenticação', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  test('regista uma conta, entra com as credenciais e lê o perfil com o token', async ({
    client,
    assert,
  }) => {
    const signup = await client.post('/api/v1/auth/signup').json(account)
    signup.assertStatus(200)
    assert.equal(signup.body().data.user.email, account.email)
    assert.notProperty(signup.body().data.user, 'password')

    const login = await client
      .post('/api/v1/auth/login')
      .json({ email: account.email, password: account.password })
    login.assertStatus(200)
    const token = login.body().data.token as string
    assert.isString(token)

    const profile = await client.get('/api/v1/account/profile').bearerToken(token)
    profile.assertStatus(200)
    assert.equal(profile.body().data.fullName, account.fullName)
  })

  test('recusa email repetido, palavra-passe errada e perfil sem token', async ({ client }) => {
    await client.post('/api/v1/auth/signup').json(account)
    const duplicate = await client.post('/api/v1/auth/signup').json(account)
    duplicate.assertStatus(422)

    const wrong = await client
      .post('/api/v1/auth/login')
      .json({ email: account.email, password: 'errada-errada' })
    wrong.assertStatus(400)

    const anonymous = await client.get('/api/v1/account/profile')
    anonymous.assertStatus(401)
  })
})
