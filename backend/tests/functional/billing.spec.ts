import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { billingServices } from '#platform/billing/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { planCode, publishPlan, subscribe } from '#tests/support/billing_fixture'

const services = () => billingServices()

test.group('billing | planos versionados', (group) => {
  group.each.setup(async () => {
    await resetAuthState()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  const draft = (code: string, extra: Record<string, unknown> = {}) =>
    services().createPlan.execute({
      planCode: code,
      name: 'Plano',
      currency: 'aoa',
      price: '49.9000',
      billingInterval: 'MONTH',
      limits: { members: 5 },
      ...extra,
    })

  test('cada criação é uma nova revisão; publicar fixa-a e só uma versão publicada é contratável', async ({
    assert,
  }) => {
    const code = planCode()
    const r1 = await draft(code)
    const r2 = await draft(code, { price: '59.9000' })
    assert.deepEqual([r1.revision, r2.revision], [1, 2])
    assert.strictEqual(r1.currency, 'AOA')
    assert.strictEqual(r1.status, 'DRAFT')

    const tenant = await createActiveTenant()
    await capture(() =>
      services().assignSubscription.execute({ tenantId: tenant.id, planCode: code })
    )
    const notPublished = await capture(() =>
      services().assignSubscription.execute({ tenantId: tenant.id, planCode: code, revision: 1 })
    )
    assert.strictEqual((notPublished as any).code, 'PLAN_NOT_PUBLISHED')

    const published = await services().publishPlan.execute(code, 1)
    assert.strictEqual(published.status, 'PUBLISHED')
    // Publicar de novo é idempotente; retirar uma não publicada não é possível.
    assert.strictEqual((await services().publishPlan.execute(code, 1)).status, 'PUBLISHED')
    const retireDraft = await capture(() => services().retirePlan.execute(code, 2))
    assert.strictEqual((retireDraft as any).code, 'INVALID_STATE_TRANSITION')
  })

  test('revisões concorrentes não colidem', async ({ assert }) => {
    const code = planCode()
    const results = await Promise.all([1, 2, 3, 4].map(() => draft(code)))
    assert.sameMembers(
      results.map((r) => r.revision),
      [1, 2, 3, 4]
    )
  })

  test('uma versão publicada é imutável na base (preços e limites nunca mudam retroactivamente)', async ({
    assert,
  }) => {
    const plan = await publishPlan(5)
    for (const sql of [
      `update plan_versions set price = 1 where id = '${plan.id}'`,
      `update plan_versions set limits = '{"members": 9999}' where id = '${plan.id}'`,
      `update plan_versions set status = 'DRAFT' where id = '${plan.id}'`,
      `delete from plan_versions where id = '${plan.id}'`,
    ]) {
      const error = await capture(() => db.connection('runtime').rawQuery(sql))
      assert.match(error.message, /imutável|não se apaga/, sql)
    }
    // O único movimento permitido é publicada → retirada, sem mexer no resto.
    const retired = await services().retirePlan.execute(plan.planCode, plan.revision)
    assert.strictEqual(retired.status, 'RETIRED')
    assert.strictEqual(retired.price, plan.price)
    const back = await capture(() =>
      db
        .connection('runtime')
        .rawQuery(`update plan_versions set status = 'PUBLISHED' where id = '${plan.id}'`)
    )
    assert.match(back.message, /imutável/)
  })

  test('valida limites, preço e moeda', async ({ assert }) => {
    for (const bad of [
      { limits: {} },
      { limits: { members: -3 } },
      { limits: { members: 1, other: 2 } },
      { price: '-1' },
      { price: '10,5' },
      { currency: 'KZ' },
      { billingInterval: 'WEEK' },
      { entitlements: { modules: ['x', 'x'] } },
    ]) {
      const error = await capture(() => draft(planCode(), bad))
      assert.strictEqual((error as any).status, 422, JSON.stringify(bad))
    }
  })
})

test.group('billing | assinaturas e limites', (group) => {
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

  const assign = (tenantId: string, code: string, extra: Record<string, unknown> = {}) =>
    services().assignSubscription.execute({ tenantId, planCode: code, ...extra })

  test('atribuir é idempotente; outro plano exige mudança; repetição concorrente não duplica', async ({
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const a = await publishPlan(5)
    const b = await publishPlan(8)
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => assign(tenant.id, a.planCode)))
    assert.lengthOf(new Set(results.map((r) => r.id)), 1)
    const rows = await db.connection('owner').from('subscriptions').where('tenant_id', tenant.id)
    assert.lengthOf(rows, 1)
    const changes = await db
      .connection('owner')
      .from('subscription_changes')
      .where('tenant_id', tenant.id)
    assert.lengthOf(changes, 1)

    const other = await capture(() => assign(tenant.id, b.planCode))
    assert.strictEqual((other as any).code, 'SUBSCRIPTION_EXISTS')
    const unknown = await capture(() => assign('00000000-0000-4000-8000-000000000000', a.planCode))
    assert.strictEqual((unknown as any).status, 404)
  })

  test('período de teste e estados: tolerância, suspensão, cancelamento e nova assinatura', async ({
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const plan = await publishPlan(5)
    const trial = await assign(tenant.id, plan.planCode, { trialDays: 14 })
    assert.strictEqual(trial.status, 'TRIAL')
    assert.isNotNull(trial.trialEnd)
    assert.strictEqual(await services().resolveLimit.execute(tenant.id, 'members'), 5)

    const set = (status: any, graceDays?: number) =>
      services().setSubscriptionStatus.execute({ tenantId: tenant.id, status, graceDays })
    assert.strictEqual((await set('ACTIVE')).status, 'ACTIVE')
    const pastDue = await set('PAST_DUE', 3)
    assert.isNotNull(pastDue.graceEnd)
    assert.strictEqual(await services().resolveLimit.execute(tenant.id, 'members'), 5)
    assert.strictEqual((await set('SUSPENDED')).graceEnd, null)
    assert.strictEqual(await services().resolveLimit.execute(tenant.id, 'members'), 0)
    await set('CANCELLED')
    assert.strictEqual(await services().resolveLimit.execute(tenant.id, 'members'), 0)
    const final = await capture(() => set('ACTIVE'))
    assert.strictEqual((final as any).code, 'NOT_FOUND')

    // Cancelada liberta o tenant para uma nova assinatura; o histórico guarda tudo.
    const again = await assign(tenant.id, plan.planCode)
    assert.notStrictEqual(again.id, trial.id)
    const kinds = await db
      .connection('owner')
      .from('subscription_changes')
      .where('tenant_id', tenant.id)
      .orderBy('occurred_at')
    assert.isAbove(kinds.length, 5)
  })

  test('o histórico de mudanças é imutável', async ({ assert }) => {
    const tenant = await createActiveTenant()
    await subscribe(tenant)
    for (const sql of [
      `update subscription_changes set kind = 'UPGRADED' where tenant_id = '${tenant.id}'`,
      `delete from subscription_changes where tenant_id = '${tenant.id}'`,
    ]) {
      const error = await capture(() => db.connection('runtime').rawQuery(sql))
      assert.match(error.message, /imut/i)
    }
  })

  test('GET /tenant/subscription: exige subscription.read, mostra a versão contratada e o consumo', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const operator = await newActor(client, tenant)
    const http = api(client, tenant, admin)

    // Sem assinatura: 404 (com a permissão); sem permissão: 403.
    ;(await http.get('/api/v1/tenant/subscription')).assertStatus(404)
    ;(await api(client, tenant, operator).get('/api/v1/tenant/subscription')).assertStatus(403)

    const plan = await publishPlan(10, {
      price: '49.9000',
      entitlements: { modules: ['sales'], features: ['sales.quotes'] },
    })
    await assign(tenant.id, plan.planCode)
    const response = await http.get('/api/v1/tenant/subscription')
    response.assertStatus(200)
    const data = response.body().data
    assert.strictEqual(data.plan.code, plan.planCode)
    assert.strictEqual(data.plan.price, '49.9000') // decimal como string
    assert.deepEqual(data.plan.limits, { members: 10 })
    assert.deepEqual(data.plan.entitlements, { modules: ['sales'], features: ['sales.quotes'] })
    assert.strictEqual(data.subscription.status, 'ACTIVE')
    assert.isTrue(data.subscription.entitled)
    assert.deepEqual(data.usage, [{ metric: 'members', used: 2, limit: 10, blocked: false }])
    assert.notProperty(data, 'tenantId')
    assert.notInclude(JSON.stringify(data), tenant.id)

    // Uma revisão nova do plano não altera o que o tenant contratou.
    await services().createPlan.execute({
      planCode: plan.planCode,
      name: 'Plano v2',
      currency: 'AOA',
      price: '99.0000',
      billingInterval: 'MONTH',
      limits: { members: 1 },
    })
    await services().publishPlan.execute(plan.planCode, 2)
    const same = (await http.get('/api/v1/tenant/subscription')).body().data
    assert.strictEqual(same.plan.revision, 1)
    assert.strictEqual(same.plan.price, '49.9000')
  })

  test('cada tenant vê só a sua assinatura', async ({ client, assert }) => {
    const a = await createActiveTenant()
    const b = await createActiveTenant()
    const adminA = await newActor(client, a, true)
    const planA = await subscribe(a, 7)
    const planB = await subscribe(b, 99)
    const seen = (await api(client, a, adminA).get('/api/v1/tenant/subscription')).body().data
    assert.strictEqual(seen.plan.code, planA.planCode)
    assert.notInclude(JSON.stringify(seen), planB.planCode)
    // Selector de outro tenant: 403, igual a "sem membership".
    ;(await api(client, b, adminA).get('/api/v1/tenant/subscription')).assertStatus(403)
  })

  test('upgrade aplica-se logo e fica no histórico; downgrade que excede exige adequação e nunca elimina', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    await newActor(client, tenant) // 2 membros ocupados
    await newActor(client, tenant) // 3
    const http = api(client, tenant, admin)
    const small = await publishPlan(5)
    const big = await publishPlan(null)
    const tiny = await publishPlan(1)
    await assign(tenant.id, small.planCode)

    const up = await services().changePlan.execute({ tenantId: tenant.id, planCode: big.planCode })
    assert.strictEqual(up.planVersionId, big.id)
    assert.isNull(up.adequacyUntil)

    // Excede (3 > 1): recusa e diz porquê; nada muda.
    const refused = await capture(() =>
      services().changePlan.execute({ tenantId: tenant.id, planCode: tiny.planCode })
    )
    assert.strictEqual((refused as any).status, 409)
    assert.strictEqual((refused as any).code, 'PLAN_LIMITS_EXCEEDED')
    assert.strictEqual((refused as any).details[0].path, 'limits.members')
    const unchanged = (await http.get('/api/v1/tenant/subscription')).body().data
    assert.strictEqual(unchanged.plan.code, big.planCode)

    // Com período de adequação: aplica, mantém todos os membros e bloqueia novos consumos.
    const down = await services().changePlan.execute({
      tenantId: tenant.id,
      planCode: tiny.planCode,
      adequacyDays: 30,
    })
    assert.isNotNull(down.adequacyUntil)
    const view = (await http.get('/api/v1/tenant/subscription')).body().data
    assert.deepEqual(view.usage, [{ metric: 'members', used: 3, limit: 1, blocked: true }])
    assert.isNotNull(view.subscription.adequacyUntil)
    assert.deepEqual(
      view.history.map((h: any) => h.kind),
      ['DOWNGRADED', 'UPGRADED', 'ASSIGNED']
    )
    const members = (await http.get('/api/v1/memberships')).body().data
    assert.lengthOf(members, 3)
    assert.strictEqual(await services().resolveLimit.execute(tenant.id, 'members'), 1)

    // Voltar a um plano que cabe limpa a adequação.
    const back = await services().changePlan.execute({
      tenantId: tenant.id,
      planCode: small.planCode,
    })
    assert.isNull(back.adequacyUntil)
    const invalid = await capture(() =>
      services().changePlan.execute({
        tenantId: tenant.id,
        planCode: small.planCode,
        adequacyDays: 0,
      })
    )
    assert.strictEqual((invalid as any).status, 422)
  })
})
