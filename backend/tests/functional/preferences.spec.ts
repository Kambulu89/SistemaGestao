import { test } from '@japa/runner'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
} from '#tests/support/fixtures'

test.group('preferências do membro (favoritos e painel)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('guarda, normaliza e devolve favoritos e o painel', async ({ client, assert }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    const api = as(client, s)

    const empty = await api.get('/api/v1/me/preferences/favorites')
    assert.equal(empty.status(), 200)
    assert.isNull(empty.body().data)

    const saved = await api.put('/api/v1/me/preferences/favorites', {
      value: [
        { path: '/contabilidade/lancamentos', title: '  Lançamentos  ' },
        { path: '/auditoria', title: 'Auditoria' },
      ],
    })
    assert.equal(saved.status(), 200)
    assert.deepEqual(saved.body().data[0], {
      path: '/contabilidade/lancamentos',
      title: 'Lançamentos',
    })
    const again = await api.get('/api/v1/me/preferences/favorites')
    assert.lengthOf(again.body().data, 2)

    // Substitui (não acumula).
    await api.put('/api/v1/me/preferences/favorites', {
      value: [{ path: '/auditoria', title: 'Auditoria' }],
    })
    assert.lengthOf((await api.get('/api/v1/me/preferences/favorites')).body().data, 1)

    const dash = await api.put('/api/v1/me/preferences/dashboard', {
      value: { order: ['approvals', 'members', 'approvals'], hidden: ['usage'] },
    })
    assert.deepEqual(dash.body().data, { order: ['approvals', 'members'], hidden: ['usage'] })
  })

  test('recusa valores inválidos e chaves desconhecidas', async ({ client, assert }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const api = as(client, await signIn(client, admin.email, tenant.id))
    for (const value of [
      'x',
      [{ path: 'sem-barra', title: 'A' }],
      [{ path: 'https://evil.example/', title: 'A' }],
      [{ path: '/a', title: '' }],
      [
        { path: '/a', title: 'A' },
        { path: '/a', title: 'B' },
      ],
      Array.from({ length: 31 }, (_, i) => ({ path: `/p${i}`, title: 'P' })),
    ]) {
      const r = await api.put('/api/v1/me/preferences/favorites', { value })
      assert.equal(r.status(), 422, JSON.stringify(value))
    }
    const badDash = await api.put('/api/v1/me/preferences/dashboard', {
      value: { order: ['<script>'] },
    })
    assert.equal(badDash.status(), 422)
    assert.equal((await api.get('/api/v1/me/preferences/segredo')).status(), 404)
    assert.equal((await api.put('/api/v1/me/preferences/segredo', { value: 1 })).status(), 404)
  })

  test('cada membro e cada empresa têm as suas preferências', async ({ client, assert }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    const role = await createRole(client, s, 'leitor', ['audit.read'])
    const other = await memberWithRoles(client, s, [role.id])
    await as(client, s).put('/api/v1/me/preferences/favorites', {
      value: [{ path: '/auditoria', title: 'Auditoria' }],
    })
    const theirs = await as(client, other.session).get('/api/v1/me/preferences/favorites')
    assert.equal(theirs.status(), 200)
    assert.isNull(theirs.body().data)

    const second = await tenantWithAdmin()
    const s2 = await signIn(client, second.admin.email, second.tenant.id)
    assert.isNull((await as(client, s2).get('/api/v1/me/preferences/favorites')).body().data)
    // O mesmo utilizador noutra empresa onde não é membro não lê nada.
    const foreign = await as(client, { ...s, tenantId: second.tenant.id }).get(
      '/api/v1/me/preferences/favorites'
    )
    assert.oneOf(foreign.status(), [403, 404])
  })
})
