import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createUser,
  login,
  signIn,
  subscribe,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const P = '/api/v1/platform'

async function platformAdmin(client: any) {
  const user = await createUser()
  await db
    .connection('owner')
    .rawQuery('update users set is_platform_admin = true where id = ?', [user.id])
  const { cookie, xsrf } = await login(client, user.email)
  return { cookie, xsrf, tenantId: '', userId: user.id } as Session & { userId: string }
}

async function plan(
  client: any,
  p: Session,
  code: string,
  features: object[],
  trialDays = 0,
  publish = true
) {
  const created = await as(client, p).post(`${P}/plans`, {
    code,
    name: `Plano ${code}`,
    trialDays,
    features,
  })
  if (created.status() !== 201) throw new Error(JSON.stringify(created.body()))
  if (publish) await as(client, p).post(`${P}/plans/${created.body().data.id}/publish`)
  return created.body().data as { id: string; version: number }
}

test.group('subscrições | planos e plataforma', (group) => {
  group.each.setup(() => cleanDatabase())

  test('só administradores da plataforma; a plataforma não entra nos dados das empresas', async ({
    client,
  }) => {
    const { tenant, admin } = await tenantWithAdmin()
    const s = await signIn(client, admin.email, tenant.id)
    ;(await as(client, s).get(`${P}/plans`)).assertStatus(403)
    const p = await platformAdmin(client)
    ;(await as(client, p).get(`${P}/plans`)).assertStatus(200)
    const intrude = await as(client, { ...p, tenantId: tenant.id }).get('/api/v1/members')
    intrude.assertStatus(403)
    intrude.assertBodyContains({ error: { code: 'TENANT_ACCESS_DENIED' } })
  })

  test('plano: validação, edição só em rascunho, publicado imutável (também na base), retirado', async ({
    client,
    assert,
  }) => {
    const p = await platformAdmin(client)
    const bad = await as(client, p).post(`${P}/plans`, {
      code: 'X',
      name: 'Plano',
      features: [{ featureCode: 'nao.existe' }, { featureCode: 'organization', limitValue: 3 }],
    })
    bad.assertStatus(422)
    assert.includeMembers(
      bad.body().error.details.map((d: any) => d.code),
      ['INVALID_CODE', 'UNKNOWN_FEATURE', 'NOT_A_LIMIT']
    )
    const draft = await plan(client, p, 'BASE', [{ featureCode: 'organization' }], 0, false)
    const edited = await as(client, p).patch(`${P}/plans/${draft.id}`, {
      expectedVersion: draft.version,
      features: [{ featureCode: 'organization' }, { featureCode: 'members.max', limitValue: 5 }],
    })
    edited.assertStatus(200)
    assert.lengthOf(edited.body().data.features, 2)
    ;(await as(client, p).post(`${P}/plans/${draft.id}/publish`)).assertStatus(200)
    const locked = await as(client, p).patch(`${P}/plans/${draft.id}`, {
      expectedVersion: 2,
      name: 'Outro nome',
    })
    locked.assertStatus(409)
    locked.assertBodyContains({ error: { code: 'PLAN_IMMUTABLE' } })
    let blocked = ''
    try {
      await db
        .connection('owner')
        .rawQuery(`delete from plan_features where plan_id = ?`, [draft.id])
    } catch (error) {
      blocked = (error as Error).message
    }
    assert.include(blocked, 'PLAN_IMMUTABLE')
    ;(await as(client, p).post(`${P}/plans/${draft.id}/retire`)).assertStatus(200)
    ;(await as(client, p).post(`${P}/plans/${draft.id}/publish`)).assertStatus(409)
  })

  test('ciclo de vida: experimental, activa, suspende (com motivo), reactiva, cancela; histórico só de acrescentar', async ({
    client,
    assert,
  }) => {
    const p = await platformAdmin(client)
    const { tenant } = await tenantWithAdmin('VIDA', false)
    const trialPlan = await plan(client, p, 'TRIAL', [{ featureCode: 'organization' }], 14)
    const started = await as(client, p).post(`${P}/tenants/${tenant.id}/subscription`, {
      planId: trialPlan.id,
    })
    started.assertStatus(201)
    const sub = started.body().data
    assert.equal(sub.status, 'TRIALING')
    assert.isNotNull(sub.trialEndsAt)
    ;(
      await as(client, p).post(`${P}/tenants/${tenant.id}/subscription`, { planId: trialPlan.id })
    ).assertStatus(409)

    const t = (action: string, version: number, extra: object = {}) =>
      as(client, p).post(`${P}/subscriptions/${sub.id}/transitions`, {
        action,
        expectedVersion: version,
        ...extra,
      })
    ;(await t('REACTIVATE', 1)).assertStatus(409)
    ;(await t('ACTIVATE', 1)).assertStatus(200)
    ;(await t('SUSPEND', 2)).assertStatus(422)
    ;(await t('SUSPEND', 2, { reason: 'Falta de pagamento' })).assertStatus(200)
    ;(await t('REACTIVATE', 2)).assertStatus(409)
    ;(await t('REACTIVATE', 3)).assertStatus(200)
    ;(await t('CANCEL', 4, { reason: 'Pedido do cliente' })).assertStatus(200)
    ;(await t('REACTIVATE', 5)).assertStatus(409)

    const view = await as(client, p).get(`${P}/tenants/${tenant.id}/subscription`)
    assert.deepEqual(
      view.body().data.history.map((e: any) => e.action),
      ['CANCEL', 'REACTIVATE', 'SUSPEND', 'ACTIVATE', 'START']
    )
    assert.equal(view.body().data.effectiveStatus, 'NONE')
    let blocked = ''
    try {
      await db.connection('owner').rawQuery(`update subscription_events set reason = 'x'`)
    } catch (error) {
      blocked = (error as Error).message
    }
    assert.include(blocked, 'SUBSCRIPTION_HISTORY_APPEND_ONLY')
    // Depois de cancelada, pode começar uma nova.
    ;(
      await as(client, p).post(`${P}/tenants/${tenant.id}/subscription`, {
        planId: trialPlan.id,
        trial: false,
      })
    ).assertStatus(201)
  })

  test('plataforma cria tenants e suspende-os (os membros perdem o acesso)', async ({
    client,
    assert,
  }) => {
    const p = await platformAdmin(client)
    const owner = await createUser()
    const created = await as(client, p).post(`${P}/tenants`, {
      code: 'NOVA',
      name: 'Nova, Lda.',
      countryCode: 'AO',
      defaultCurrency: 'AOA',
      adminEmail: owner.email,
    })
    created.assertStatus(201)
    const tenant = created.body().data
    const s = await signIn(client, owner.email, tenant.id)
    ;(await as(client, s).get('/api/v1/context')).assertStatus(200)
    const list = await as(client, p).get(`${P}/tenants?q=nova`)
    assert.deepInclude(list.body().data[0], { code: 'NOVA', subscriptionStatus: 'NONE' })
    ;(
      await as(client, p).patch(`${P}/tenants/${tenant.id}`, {
        expectedVersion: 1,
        status: 'SUSPENDED',
      })
    ).assertStatus(200)
    const denied = await as(client, s).get('/api/v1/context')
    denied.assertStatus(403)
    denied.assertBodyContains({ error: { code: 'TENANT_UNAVAILABLE' } })
  })
})

test.group('subscrições | funcionalidades e limites aplicados', (group) => {
  group.each.setup(() => cleanDatabase())

  test('sem plano, com plano sem a funcionalidade, suspenso ou expirado: NOT_ENTITLED mesmo para o administrador', async ({
    client,
  }) => {
    const p = await platformAdmin(client)
    const { tenant, admin } = await tenantWithAdmin('GATE', false)
    const s = await signIn(client, admin.email, tenant.id)
    const org = () => as(client, s).get('/api/v1/organization/legal-entities')
    ;(await org()).assertStatus(403)
    ;(await org()).assertBodyContains({ error: { code: 'NOT_ENTITLED' } })

    const without = await plan(client, p, 'SEM_ORG', [
      { featureCode: 'members.max', limitValue: 10 },
    ])
    const sub = (await subscribe(tenant.id, without.id))!
    ;(await org()).assertStatus(403)

    const withOrg = await plan(client, p, 'COM_ORG', [{ featureCode: 'organization' }])
    await as(client, p).post(`${P}/subscriptions/${sub.id}/transitions`, {
      action: 'CHANGE_PLAN',
      expectedVersion: sub.version,
      planId: withOrg.id,
    })
    ;(await org()).assertStatus(200)
    await as(client, p).post(`${P}/subscriptions/${sub.id}/transitions`, {
      action: 'SUSPEND',
      expectedVersion: sub.version + 1,
      reason: 'Teste',
    })
    ;(await org()).assertStatus(403)
    await as(client, p).post(`${P}/subscriptions/${sub.id}/transitions`, {
      action: 'REACTIVATE',
      expectedVersion: sub.version + 2,
    })
    ;(await org()).assertStatus(200)
    // Data de fim passada → EXPIRED (derivado, sem job).
    await db
      .connection('owner')
      .rawQuery(`update subscriptions set ends_at = now() - interval '1 day' where id = ?`, [
        sub.id,
      ])
    ;(await org()).assertStatus(403)
  })

  test('período experimental terminado expira; uma excepção liga ou desliga uma funcionalidade e expira', async ({
    client,
    assert,
  }) => {
    const p = await platformAdmin(client)
    const { tenant, admin } = await tenantWithAdmin('TRIALX', false)
    const s = await signIn(client, admin.email, tenant.id)
    const trialPlan = await plan(client, p, 'TRIAL2', [{ featureCode: 'organization' }], 7)
    const sub = (await subscribe(tenant.id, trialPlan.id, true))!
    const org = () => as(client, s).get('/api/v1/organization/legal-entities')
    ;(await org()).assertStatus(200)
    await db
      .connection('owner')
      .rawQuery(
        `update subscriptions set trial_ends_at = now() - interval '1 minute' where id = ?`,
        [sub.id]
      )
    ;(await org()).assertStatus(403)

    const noReason = await as(client, p).put(
      `${P}/tenants/${tenant.id}/entitlements/organization`,
      { enabled: true }
    )
    noReason.assertStatus(422)
    const granted = await as(client, p).put(`${P}/tenants/${tenant.id}/entitlements/organization`, {
      enabled: true,
      reason: 'Prolongamento acordado',
    })
    granted.assertStatus(200)
    assert.deepInclude(
      granted.body().data.entitlements.find((e: any) => e.code === 'organization'),
      { enabled: true, source: 'OVERRIDE' }
    )
    ;(await org()).assertStatus(200)
    await db
      .connection('owner')
      .rawQuery(
        `update tenant_entitlement_overrides set expires_at = now() - interval '1 minute' where tenant_id = ?`,
        [tenant.id]
      )
    ;(await org()).assertStatus(403)
    ;(
      await as(client, p).delete(`${P}/tenants/${tenant.id}/entitlements/organization`)
    ).assertStatus(200)
    ;(
      await as(client, p).delete(`${P}/tenants/${tenant.id}/entitlements/organization`)
    ).assertStatus(404)
  })

  test('limites de membros e de entidades legais; convites simultâneos não ultrapassam o limite', async ({
    client,
    assert,
  }) => {
    const p = await platformAdmin(client)
    const { tenant, admin } = await tenantWithAdmin('LIM', false)
    const s = await signIn(client, admin.email, tenant.id)
    const limited = await plan(client, p, 'PEQUENO', [
      { featureCode: 'organization' },
      { featureCode: 'members.max', limitValue: 2 },
      { featureCode: 'legal_entities.max', limitValue: 1 },
    ])
    await subscribe(tenant.id, limited.id)
    const invites = await Promise.all(
      ['a', 'b', 'c'].map((x) =>
        as(client, s).post('/api/v1/members/invitations', { email: `${x}@limite.invalid` })
      )
    )
    assert.sameMembers(
      invites.map((r) => r.status()),
      [201, 409, 409]
    )
    assert.include(
      invites.filter((r) => r.status() === 409).map((r) => r.body().error.code),
      'LIMIT_REACHED'
    )
    const le = (code: string, taxId: string) =>
      as(client, s).post('/api/v1/organization/legal-entities', {
        code,
        legalName: `Entidade ${code}`,
        taxId,
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    ;(await le('E1', '5000000101')).assertStatus(201)
    const second = await le('E2', '5000000102')
    second.assertStatus(409)
    second.assertBodyContains({ error: { code: 'LIMIT_REACHED' } })
  })

  test('a empresa vê a própria subscrição com subscription.read', async ({ client, assert }) => {
    const { tenant, admin } = await tenantWithAdmin('VER')
    const s = await signIn(client, admin.email, tenant.id)
    const view = await as(client, s).get('/api/v1/tenant/subscription')
    view.assertStatus(200)
    assert.equal(view.body().data.status, 'ACTIVE')
    assert.equal(view.body().data.plan.code, 'TESTE_TUDO')
    assert.isTrue(view.body().data.entitlements.every((e: any) => e.enabled))
  })
})
