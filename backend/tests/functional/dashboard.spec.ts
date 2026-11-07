import { test } from '@japa/runner'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  subscribe,
  tenantWithAdmin,
} from '#tests/support/fixtures'

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  for (const [code, taxId] of [
    ['ALFA', '5000000011'],
    ['BETA', '5000000012'],
    ['GAMA', '5000000013'],
  ])
    await as(client, s).post('/api/v1/organization/legal-entities', {
      code,
      legalName: `Entidade ${code}, Lda.`,
      taxId,
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  return { s, tenantId: tenant.id }
}

test.group('painel, pesquisa global e ordenação', (group) => {
  group.each.setup(() => cleanDatabase())

  test('o painel só traz as secções que o membro pode ver', async ({ client, assert }) => {
    const { s } = await setup(client)
    const full = (await as(client, s).get('/api/v1/dashboard')).body().data
    assert.equal(full.subscriptionStatus, 'ACTIVE')
    assert.equal(full.members.ACTIVE, 1)
    assert.equal(full.organization.legalEntities, 3)
    assert.deepInclude(full.usage.legalEntities, { used: 3, enabled: true })
    assert.equal(full.approvals.scope, 'TENANT')
    assert.lengthOf(full.approvals.weekly, 8)
    assert.isAbove(full.activity.length, 0)

    const plain = await memberWithRoles(client, s, [])
    const limited = (await as(client, plain.session).get('/api/v1/dashboard')).body().data
    assert.isNull(limited.members)
    assert.isNull(limited.organization)
    assert.isNull(limited.usage)
    assert.isNull(limited.activity)
    assert.equal(limited.approvals.scope, 'MINE')
    assert.deepEqual(limited.approvals.byStatus, {})
  })

  test('sem a funcionalidade contratada a secção vem vazia mesmo para o administrador', async ({
    client,
    assert,
  }) => {
    const { PlatformSubscriptionService } = await import('#modules/subscription/index')
    const plans = new PlatformSubscriptionService()
    const plan = await plans.createPlan({ code: 'MINIMO', name: 'Mínimo', features: [] })
    await plans.setPlanStatus(plan.id, 'ACTIVE')
    const { tenant, admin } = await tenantWithAdmin(undefined, false)
    await subscribe(tenant.id, plan.id)
    const s = await signIn(client, admin.email, tenant.id)
    const data = (await as(client, s).get('/api/v1/dashboard')).body().data
    assert.isNull(data.organization)
    assert.isNull(data.approvals)
    assert.isNotNull(data.members)
    assert.lengthOf((await as(client, s).get('/api/v1/search?q=entidade')).body().data, 0)
  })

  test('pesquisa global respeita permissões, visibilidade e empresa', async ({
    client,
    assert,
  }) => {
    const { s } = await setup(client)
    const role = await createRole(client, s, 'leitura_org', ['organization.read'])
    const reader = await memberWithRoles(client, s, [role.id])
    ;(await as(client, s).get('/api/v1/search?q=a')).assertStatus(422)

    const admin = (await as(client, s).get('/api/v1/search?q=beta')).body().data
    assert.deepInclude(admin[0], { type: 'organization', kind: 'legalEntities' })
    assert.include(admin[0].title, 'BETA')
    const roles = (await as(client, s).get('/api/v1/search?q=leitura')).body().data
    assert.deepInclude(roles[0], { type: 'role', title: 'Perfil leitura_org' })

    const asReader = (await as(client, reader.session).get('/api/v1/search?q=leitura')).body().data
    assert.lengthOf(asReader, 0)
    const people = (await as(client, reader.session).get('/api/v1/search?q=membro')).body().data
    assert.lengthOf(people, 0)
    const entities = (await as(client, reader.session).get('/api/v1/search?q=gama')).body().data
    assert.lengthOf(entities, 1)

    const other = await tenantWithAdmin()
    const outsider = await signIn(client, other.admin.email, other.tenant.id)
    assert.lengthOf((await as(client, outsider).get('/api/v1/search?q=entidade')).body().data, 0)
  })

  test('listas ordenadas no servidor; campos não ordenáveis são recusados', async ({
    client,
    assert,
  }) => {
    const { s } = await setup(client)
    const desc = await as(client, s).get(
      '/api/v1/organization/legal-entities?sort=code&direction=desc'
    )
    assert.deepEqual(
      desc.body().data.map((r: any) => r.code),
      ['GAMA', 'BETA', 'ALFA']
    )
    const bad = await as(client, s).get('/api/v1/organization/legal-entities?sort=password')
    bad.assertStatus(422)
    await memberWithRoles(client, s, [])
    const members = await as(client, s).get('/api/v1/members?sort=email&direction=desc')
    const emails = members.body().data.map((m: any) => m.email)
    assert.deepEqual(emails, [...emails].sort().reverse())
    ;(await as(client, s).get('/api/v1/members?sort=password_hash')).assertStatus(422)
  })
})
