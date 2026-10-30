import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { administrationServices } from '#platform/administration/index'
import { billingServices } from '#platform/billing/index'
import { capture } from '#tests/support/capture'
import {
  createActiveUser,
  deleteTestUsers,
  mailbox,
  resetAuthState,
} from '#tests/support/auth_fixture'
import {
  createActiveTenant,
  deleteTestTenants,
  tenantCode,
} from '#tests/support/membership_fixture'
import { api, login, newActor } from '#tests/support/api_fixture'
import { publishPlan } from '#tests/support/billing_fixture'

/** Pedido autenticado de plataforma (sem selector de tenant). */
function platformApi(client: any, actor: { cookie: string; csrf: string }) {
  const base = (request: any, write: boolean) => {
    request.header('cookie', actor.cookie)
    return write ? request.header('x-csrf-token', actor.csrf) : request
  }
  return {
    get: (url: string) => base(client.get(url), false),
    post: (url: string, body: unknown = {}) => base(client.post(url), true).json(body),
    put: (url: string, body: unknown) => base(client.put(url), true).json(body),
  }
}

async function platformUser(
  client: any,
  permissions: string[] = ['platform.tenant.manage', 'platform.billing.manage']
) {
  const { user, email } = await createActiveUser()
  for (const permission of permissions) {
    await administrationServices().grant.execute({
      userId: user.id,
      permission,
      reason: 'Teste',
    })
  }
  const session = await login(client, email)
  return { user, email, ...session, http: platformApi(client, session) }
}

test.group('plataforma | permissões', (group) => {
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

  test('sem concessão (mesmo administrador de tenant) o acesso é negado e fica registado', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const tenantAdmin = await newActor(client, tenant, true)
    const http = platformApi(client, tenantAdmin)
    for (const response of [
      await http.get('/api/v1/platform/tenants'),
      await http.get('/api/v1/platform/plans'),
      await http.post('/api/v1/platform/tenants', {}),
      await http.post(`/api/v1/platform/tenants/${tenant.id}/suspend`, { reason: 'x' }),
    ]) {
      assert.strictEqual(response.status(), 403)
      assert.strictEqual(response.body().error.code, 'PLATFORM_PERMISSION_DENIED')
    }
    const events = await db
      .connection('owner')
      .from('security_events')
      .where('user_id', tenantAdmin.userId)
      .where('event_type', 'PLATFORM_ACCESS_DENIED')
    assert.isAtLeast(events.length, 4)
    // Sem sessão: 401.
    ;(await client.get('/api/v1/platform/tenants')).assertStatus(401)
  })

  test('cada permissão cobre a sua área; revogar fecha o acesso; expiradas não valem', async ({
    client,
    assert,
  }) => {
    const onlyTenants = await platformUser(client, ['platform.tenant.manage'])
    ;(await onlyTenants.http.get('/api/v1/platform/tenants')).assertStatus(200)
    ;(await onlyTenants.http.get('/api/v1/platform/plans')).assertStatus(403)

    const onlyBilling = await platformUser(client, ['platform.billing.manage'])
    ;(await onlyBilling.http.get('/api/v1/platform/plans')).assertStatus(200)
    ;(await onlyBilling.http.get('/api/v1/platform/tenants')).assertStatus(403)

    await administrationServices().revoke.execute(onlyBilling.user.id, 'platform.billing.manage')
    ;(await onlyBilling.http.get('/api/v1/platform/plans')).assertStatus(403)

    // Concessão com prazo no passado (inserida pela conta dona) não vale.
    await db
      .connection('owner')
      .table('platform_grants')
      .insert({
        user_id: onlyTenants.user.id,
        permission: 'platform.billing.manage',
        reason: 'expirada',
        expires_at: new Date('2020-01-01T00:00:00Z'),
      })
    ;(await onlyTenants.http.get('/api/v1/platform/plans')).assertStatus(403)

    // A revogação ficou no histórico e a concessão é imutável.
    const history = await administrationServices().listGrants.execute()
    assert.isTrue(history.some((g) => g.userId === onlyBilling.user.id && g.revokedAt !== null))
    const tamper = await capture(() =>
      db
        .connection('runtime')
        .rawQuery(
          `update platform_grants set permission = 'platform.tenant.manage' where user_id = '${onlyBilling.user.id}'`
        )
    )
    assert.match(tamper.message, /só pode ser revogada/)
    const wipe = await capture(() =>
      db
        .connection('runtime')
        .rawQuery(`delete from platform_grants where user_id = '${onlyBilling.user.id}'`)
    )
    assert.match(wipe.message, /não se apagam/)
  })

  test('GET /platform/me devolve só as concessões em vigor, sem exigir nenhuma', async ({
    client,
    assert,
  }) => {
    const none = await newActor(client, await createActiveTenant())
    const empty = await platformApi(client, none).get('/api/v1/platform/me')
    empty.assertStatus(200)
    assert.deepEqual(empty.body().data.permissions, [])

    const root = await platformUser(client, ['platform.billing.manage'])
    const mine = await root.http.get('/api/v1/platform/me')
    assert.deepEqual(mine.body().data.permissions, ['platform.billing.manage'])
    await administrationServices().revoke.execute(root.user.id, 'platform.billing.manage')
    assert.deepEqual((await root.http.get('/api/v1/platform/me')).body().data.permissions, [])
    ;(await client.get('/api/v1/platform/me')).assertStatus(401)
  })

  test('concessões: validação, duplicados e permissões desconhecidas', async ({
    client,
    assert,
  }) => {
    const { user } = await createActiveUser()
    const grant = (permission: string, extra: Record<string, unknown> = {}) =>
      administrationServices().grant.execute({ userId: user.id, permission, reason: 'x', ...extra })
    assert.strictEqual(((await capture(() => grant('iam.manage'))) as any).status, 422)
    assert.strictEqual(((await capture(() => grant('platform.nada'))) as any).status, 422)
    assert.strictEqual(
      ((await capture(() => grant('platform.tenant.manage', { reason: ' ' }))) as any).status,
      422
    )
    assert.strictEqual(
      ((await capture(() => grant('platform.tenant.manage', { expiresInDays: 0 }))) as any).status,
      422
    )
    await grant('platform.tenant.manage', { expiresInDays: 7 })
    assert.strictEqual(
      ((await capture(() => grant('platform.tenant.manage'))) as any).code,
      'GRANT_EXISTS'
    )
    void client
  })

  test('a concessão de plataforma não dá acesso aos dados de nenhum tenant', async ({
    client,
    assert,
  }) => {
    const tenant = await createActiveTenant()
    const root = await platformUser(client)
    // Sem membership: o selector de tenant é recusado em qualquer rota de tenant.
    const asTenant = api(client, tenant, {
      email: root.email,
      userId: root.user.id,
      membershipId: '',
      cookie: root.cookie,
      csrf: root.csrf,
    })
    for (const url of [
      '/api/v1/context',
      '/api/v1/memberships',
      '/api/v1/parties',
      '/api/v1/audit-logs',
    ]) {
      assert.strictEqual((await asTenant.get(url)).status(), 403, url)
    }
    // E as rotas de plataforma não aceitam selector: ignoram-no.
    const list = await root.http.get('/api/v1/platform/tenants')
    list.assertStatus(200)
  })
})

test.group('plataforma | tenants e provisionamento', (group) => {
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

  const adminEmail = () => `admin${process.pid}${Date.now()}@teste.invalid`

  test('provisiona um tenant: plano, papel, organização, convite e activação; repetir não duplica', async ({
    client,
    assert,
  }) => {
    const root = await platformUser(client)
    const plan = await publishPlan(5)
    const code = tenantCode()
    const email = adminEmail()
    const body = { code, name: 'Cliente Novo, Lda.', adminEmail: email, planCode: plan.planCode }

    const before = (await mailbox()).length
    const first = await root.http.post('/api/v1/platform/tenants', body)
    first.assertStatus(201)
    const data = first.body().data
    assert.isTrue(data.created)
    assert.strictEqual(data.tenant.status, 'ACTIVE')
    assert.strictEqual(data.tenant.plan.code, plan.planCode)
    assert.strictEqual(data.organizations, 1)
    assert.strictEqual(data.pendingInvitations, 1)
    assert.sameMembers(data.done, [
      'TENANT',
      'SUBSCRIPTION',
      'ADMIN_ROLE',
      'ORGANIZATION',
      'ADMIN_INVITATION',
      'ACTIVATION',
    ])
    assert.strictEqual((await mailbox()).length, before + 1) // um convite, nenhuma palavra-passe pedida
    assert.include(first.header('location'), `/api/v1/platform/tenants/${data.tenant.id}`)

    // Repetir: 200, sem segunda organização nem convite nem email.
    const again = await root.http.post('/api/v1/platform/tenants', body)
    again.assertStatus(200)
    assert.isFalse(again.body().data.created)
    assert.strictEqual(again.body().data.organizations, 1)
    assert.strictEqual(again.body().data.pendingInvitations, 1)
    assert.strictEqual((await mailbox()).length, before + 1)

    const detail = (await root.http.get(`/api/v1/platform/tenants/${data.tenant.id}`)).body().data
    assert.deepEqual(detail.pending, [])
    assert.notProperty(detail, 'members')
  })

  test('o administrador convidado aceita o convite e passa a administrar o tenant', async ({
    client,
    assert,
  }) => {
    const root = await platformUser(client)
    const plan = await publishPlan(5)
    const code = tenantCode()
    const invitee = await createActiveUser()
    const before = (await mailbox()).length
    ;(
      await root.http.post('/api/v1/platform/tenants', {
        code,
        name: 'Com Admin',
        adminEmail: invitee.email,
        planCode: plan.planCode,
      })
    ).assertStatus(201)
    const mails = (await mailbox()).slice(before)
    const token = (mails.at(-1) as any).token as string
    assert.isString(token)

    const session = await login(client, invitee.email)
    const accepted = await client
      .post('/api/v1/invitations/accept')
      .header('cookie', session.cookie)
      .header('x-csrf-token', session.csrf)
      .json({ token })
    accepted.assertStatus(200)
    const permissions = (
      await client
        .get('/api/v1/context')
        .header('cookie', session.cookie)
        .header('x-tenant-code', code)
    ).body().data.permissions as { code: string }[]
    assert.include(
      permissions.map((p) => p.code),
      'iam.manage'
    )
  })

  test('uma falha a meio mantém PROVISIONING e a repetição retoma sem duplicar', async ({
    client,
    assert,
  }) => {
    const root = await platformUser(client)
    const code = tenantCode()
    const body = { code, name: 'Sem Plano Ainda', adminEmail: adminEmail(), planCode: 'nao_existe' }
    // O plano não existe: falha no passo da assinatura, depois de criar o tenant.
    const failed = await root.http.post('/api/v1/platform/tenants', body)
    failed.assertStatus(404)
    const listed = (await root.http.get('/api/v1/platform/tenants')).body().data as any[]
    const mid = listed.find((t) => t.code === code)
    assert.strictEqual(mid.status, 'PROVISIONING')
    assert.isNull(mid.plan)
    const state = (await root.http.get(`/api/v1/platform/tenants/${mid.id}`)).body().data
    assert.deepEqual(state.done, ['TENANT'])
    assert.includeMembers(state.pending, ['SUBSCRIPTION', 'ACTIVATION'])

    const plan = await publishPlan(5)
    const resumed = await root.http.post('/api/v1/platform/tenants', {
      ...body,
      planCode: plan.planCode,
    })
    resumed.assertStatus(200) // o tenant já existia
    assert.strictEqual(resumed.body().data.tenant.status, 'ACTIVE')
    assert.strictEqual(resumed.body().data.organizations, 1)
    const tenants = await db.connection('owner').from('tenants').where('code', code)
    assert.lengthOf(tenants, 1)
  })

  test('validação, código repetido com outro plano e tenants fechados', async ({
    client,
    assert,
  }) => {
    const root = await platformUser(client)
    const plan = await publishPlan(5)
    const other = await publishPlan(9)
    const ok = { code: tenantCode(), name: 'X', adminEmail: adminEmail(), planCode: plan.planCode }
    for (const bad of [
      { ...ok, code: 'Maiúsculas!' },
      { ...ok, name: ' ' },
      { ...ok, adminEmail: 'sem-arroba' },
    ]) {
      ;(await root.http.post('/api/v1/platform/tenants', bad)).assertStatus(422)
    }
    ;(await root.http.post('/api/v1/platform/tenants', ok)).assertStatus(201)
    const clash = await root.http.post('/api/v1/platform/tenants', {
      ...ok,
      planCode: other.planCode,
    })
    clash.assertStatus(409)
    assert.strictEqual(clash.body().error.code, 'SUBSCRIPTION_EXISTS')
    ;(await root.http.get('/api/v1/platform/tenants/não-uuid')).assertStatus(404)
    ;(
      await root.http.get('/api/v1/platform/tenants/00000000-0000-4000-8000-000000000000')
    ).assertStatus(404)
  })

  test('suspender impede o acesso empresarial por URL directa; reactivar repõe; fica registado', async ({
    client,
    assert,
  }) => {
    const root = await platformUser(client)
    const tenant = await createActiveTenant()
    const admin = await newActor(client, tenant, true)
    const http = api(client, tenant, admin)
    ;(await http.get('/api/v1/context')).assertStatus(200)

    ;(await root.http.post(`/api/v1/platform/tenants/${tenant.id}/suspend`, {})).assertStatus(422) // motivo
    const off = await root.http.post(`/api/v1/platform/tenants/${tenant.id}/suspend`, {
      reason: 'Falta de pagamento',
    })
    off.assertStatus(200)
    assert.strictEqual(off.body().data.status, 'SUSPENDED')
    ;(await http.get('/api/v1/context')).assertStatus(403)
    ;(await http.get('/api/v1/parties')).assertStatus(403)
    // Repetir é seguro.
    ;(
      await root.http.post(`/api/v1/platform/tenants/${tenant.id}/suspend`, { reason: 'repetido' })
    ).assertStatus(200)

    ;(
      await root.http.post(`/api/v1/platform/tenants/${tenant.id}/resume`, { reason: 'Pago' })
    ).assertStatus(200)
    ;(await http.get('/api/v1/context')).assertStatus(200)

    const events = await db
      .connection('owner')
      .from('security_events')
      .where({ event_type: 'PLATFORM_ACTION', tenant_id: tenant.id, user_id: root.user.id })
    assert.includeMembers(
      events.map((e: any) => e.metadata.action),
      ['tenant.suspend', 'tenant.resume']
    )
    assert.include(JSON.stringify(events), 'Falta de pagamento')
  })
})

test.group('plataforma | planos e assinaturas', (group) => {
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

  test('ciclo de vida de um plano pela API: rascunho, publicação imutável, retirada', async ({
    client,
    assert,
  }) => {
    const root = await platformUser(client)
    const code = `t_plan_api_${process.pid}_${Date.now()}`
    const created = await root.http.post('/api/v1/platform/plans', {
      planCode: code,
      name: 'Plano API',
      currency: 'aoa',
      price: '25.5',
      billingInterval: 'MONTH',
      limits: { members: 3 },
      entitlements: { modules: ['crm'] },
    })
    created.assertStatus(201)
    assert.strictEqual(created.body().data.status, 'DRAFT')
    assert.strictEqual(created.body().data.price, '25.5000')
    ;(
      await root.http.post('/api/v1/platform/plans', {
        planCode: code,
        name: 'x',
        currency: 'AOA',
        price: '-1',
        billingInterval: 'MONTH',
        limits: { members: 3 },
      })
    ).assertStatus(422)
    ;(
      await root.http.post('/api/v1/platform/plans', {
        planCode: code,
        name: 'x',
        currency: 'AOA',
        price: '1',
        billingInterval: 'MONTH',
        limits: { members: 'muitos' },
      })
    ).assertStatus(422)

    ;(await root.http.post(`/api/v1/platform/plans/${code}/revisions/1/publish`)).assertStatus(200)
    ;(await root.http.post(`/api/v1/platform/plans/${code}/revisions/1/retire`)).assertStatus(200)
    ;(await root.http.post(`/api/v1/platform/plans/${code}/revisions/1/publish`)).assertStatus(409)
    ;(await root.http.post(`/api/v1/platform/plans/${code}/revisions/9/publish`)).assertStatus(404)
    const plans = (await root.http.get('/api/v1/platform/plans')).body().data as any[]
    assert.isTrue(plans.some((p) => p.planCode === code && p.status === 'RETIRED'))
  })

  test('atribuir, mudar de plano (com adequação) e estados pela API', async ({
    client,
    assert,
  }) => {
    const root = await platformUser(client)
    const tenant = await createActiveTenant()
    await newActor(client, tenant, true)
    await newActor(client, tenant)
    await newActor(client, tenant) // 3 membros
    const big = await publishPlan(10)
    const tiny = await publishPlan(1)
    const base = `/api/v1/platform/tenants/${tenant.id}/subscription`

    ;(await root.http.get(base)).assertStatus(404) // ainda sem assinatura
    ;(await root.http.post(base, { planCode: big.planCode })).assertStatus(200)
    ;(await root.http.post(base, { planCode: big.planCode })).assertStatus(200) // idempotente
    ;(await root.http.post(base, { planCode: tiny.planCode })).assertStatus(409)

    const refused = await root.http.put(`${base}/plan`, { planCode: tiny.planCode })
    refused.assertStatus(409)
    assert.strictEqual(refused.body().error.code, 'PLAN_LIMITS_EXCEEDED')
    const applied = await root.http.put(`${base}/plan`, {
      planCode: tiny.planCode,
      adequacyDays: 30,
    })
    applied.assertStatus(200)
    assert.isNotNull(applied.body().data.adequacyUntil)

    const view = (await root.http.get(base)).body().data
    assert.strictEqual(view.plan.planCode, tiny.planCode)
    assert.deepEqual(view.usage, [{ metric: 'members', used: 3, limit: 1, blocked: true }])
    assert.strictEqual(view.history[0].kind, 'DOWNGRADED')

    ;(await root.http.put(`${base}/status`, { status: 'SUSPENDED' })).assertStatus(200)
    ;(await root.http.put(`${base}/status`, { status: 'ACTIVE' })).assertStatus(200)
    ;(await root.http.put(`${base}/status`, { status: 'TRIAL' })).assertStatus(422)
    ;(await root.http.put(`${base}/status`, { status: 'CANCELLED' })).assertStatus(200)
    ;(await root.http.put(`${base}/status`, { status: 'ACTIVE' })).assertStatus(404) // cancelada: sem assinatura aberta
    ;(
      await root.http.get(
        '/api/v1/platform/tenants/00000000-0000-4000-8000-000000000000/subscription'
      )
    ).assertStatus(404)
    void billingServices
  })

  test('a lista de tenants mostra estado e plano', async ({ client, assert }) => {
    const root = await platformUser(client)
    const tenant = await createActiveTenant()
    const plan = await publishPlan(5)
    await billingServices().assignSubscription.execute({
      tenantId: tenant.id,
      planCode: plan.planCode,
    })
    const list = (await root.http.get('/api/v1/platform/tenants')).body().data as any[]
    const mine = list.find((t) => t.id === tenant.id)
    assert.deepEqual(mine.plan, { code: plan.planCode, revision: 1, status: 'ACTIVE' })
    assert.strictEqual(mine.status, 'ACTIVE')
  })
})
