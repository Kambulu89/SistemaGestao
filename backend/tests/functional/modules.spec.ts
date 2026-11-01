import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { LucidTenantDatabase, serviceTenantContext, type TenantContext } from '#core/tenancy/index'
import { billingServices } from '#platform/billing/index'
import {
  EnableModule,
  ListModules,
  SetFeatureOverride,
  SyncRegistry,
} from '#platform/modules/application/use_cases'
import {
  BillingLicenceReader,
  CodeModuleActivator,
  LucidRegistryStore,
  LucidTenantModuleStore,
} from '#platform/modules/infrastructure/lucid_modules'
import FeatureMiddleware from '#platform/modules/presentation/feature_middleware'
import { moduleServices } from '#platform/modules/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { TEST_MANIFESTS, license, syncTestRegistry } from '#tests/support/modules_fixture'

const FULL = ['crm', 'catalog', 'finance', 'sales', 'inventory']

async function setup(client: any, modules: string[] = FULL, features: string[] = []) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const operator = await newActor(client, tenant)
  await license(tenant, modules, features)
  return { tenant, admin, operator, http: api(client, tenant, admin) }
}

const statusOf = async (http: ReturnType<typeof api>) =>
  Object.fromEntries(
    ((await http.get('/api/v1/modules')).body().data as any[]).map((m) => [m.code, m.status])
  )

const tenantRows = (tenantId: string, table: string) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [tenantId])
    return (await trx.rawQuery(`select * from ${table}`)).rows as any[]
  })

test.group('módulos | registo', (group) => {
  group.each.setup(async () => {
    await syncTestRegistry()
  })

  test('sincronizar é idempotente, valida antes de gravar e nunca apaga', async ({ assert }) => {
    const sync = new SyncRegistry(new LucidRegistryStore())
    const again = await sync.execute(TEST_MANIFESTS)
    assert.strictEqual(again.created, 0)
    assert.strictEqual(again.updated, TEST_MANIFESTS.length)

    // Um grafo com ciclo é recusado por inteiro: nada muda.
    const cyclic = [
      ...TEST_MANIFESTS.filter((m) => m.code !== 'catalog'),
      {
        ...TEST_MANIFESTS.find((m) => m.code === 'catalog')!,
        dependencies: [{ code: 'sales', constraint: '*', optional: false }],
      },
    ]
    const error = await capture(() => sync.execute(cyclic))
    assert.strictEqual((error as any).status, 422)
    assert.strictEqual((error as any).details[0].code, 'DEPENDENCY_CYCLE')

    // O que sai do código passa a DEPRECATED (a linha e a história mantêm-se).
    // Sai o inventário e quem depende dele (a dependência, ainda que opcional, tem de existir no registo): as compras
    // (opcional), as finanças (opcional das compras) e as vendas (opcional das finanças).
    const leaving = ['inventory', 'procurement', 'finance', 'sales']
    const without = TEST_MANIFESTS.filter((m) => !leaving.includes(m.code))
    const result = await sync.execute(without)
    assert.strictEqual(result.deprecated, leaving.length)
    const row = await db.connection('owner').from('modules').where('code', 'inventory').first()
    assert.strictEqual(row.status, 'DEPRECATED')
    await sync.execute(TEST_MANIFESTS)
    const back = await db.connection('owner').from('modules').where('code', 'inventory').first()
    assert.strictEqual(back.status, 'AVAILABLE')
  })

  test('as arestas e funcionalidades do catálogo ficam gravadas', async ({ assert }) => {
    const sales = (await new LucidRegistryStore().list()).find((m) => m.code === 'sales')!
    assert.deepEqual(
      sales.dependencies.map((d) => [d.code, d.optional]),
      [
        ['catalog', false],
        ['core', false],
        ['crm', false],
        ['finance', true],
      ]
    )
    assert.deepEqual(
      sales.features.map((f) => f.code),
      ['sales.discounts', 'sales.quotes']
    )
  })
})

test.group('módulos | activação por tenant', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    await syncTestRegistry()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  test('catálogo: exige module.read e mostra dependências, licença e estado', async ({
    client,
    assert,
  }) => {
    const { tenant, operator, http } = await setup(client, ['crm', 'sales', 'catalog'])
    ;(await api(client, tenant, operator).get('/api/v1/modules')).assertStatus(403)

    const modules = (await http.get('/api/v1/modules')).body().data as any[]
    const by = Object.fromEntries(modules.map((m) => [m.code, m]))
    assert.strictEqual(by.core.status, 'ENABLED')
    assert.strictEqual(by.core.kind, 'FOUNDATION')
    assert.isTrue(by.sales.licensed)
    assert.isFalse(by.inventory.licensed)
    assert.strictEqual(by.sales.status, 'DISABLED')
    assert.deepEqual(by.sales.missingDependencies, ['catalog', 'crm'])
    assert.deepEqual(
      by.sales.requires.map((d: any) => d.code),
      ['catalog', 'core', 'crm', 'finance']
    )
    const quotes = by.sales.features.find((f: any) => f.code === 'sales.quotes')
    assert.isFalse(quotes.enabled)
    assert.strictEqual(quotes.reason, 'MODULE_DISABLED')
  })

  test('não activa SALES sem dependências; com withDependencies activa pela ordem certa', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const refused = await http.post('/api/v1/tenant/modules/sales/enable', {})
    refused.assertStatus(409)
    assert.strictEqual(refused.body().error.code, 'DEPENDENCIES_MISSING')
    assert.deepEqual(
      refused.body().error.details.map((d: any) => d.message),
      ['catalog', 'crm']
    )
    assert.strictEqual((await statusOf(http)).sales, 'DISABLED')

    const enabled = await http.post('/api/v1/tenant/modules/sales/enable', {
      withDependencies: true,
    })
    enabled.assertStatus(200)
    assert.strictEqual(enabled.body().data.status, 'ENABLED')
    const status = await statusOf(http)
    assert.deepEqual(
      [status.crm, status.catalog, status.sales, status.inventory],
      ['ENABLED', 'ENABLED', 'ENABLED', 'DISABLED']
    )
    // Dependência opcional (finance) não foi arrastada.
    assert.strictEqual(status.finance, 'DISABLED')
  })

  test('activar de novo é idempotente e activações concorrentes não duplicam', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        http.post('/api/v1/tenant/modules/sales/enable', { withDependencies: true })
      )
    )
    for (const r of results) r.assertStatus(200)
    ;(await http.post('/api/v1/tenant/modules/sales/enable', {})).assertStatus(200)
    const rows = await tenantRows(tenant.id, 'tenant_modules')
    assert.lengthOf(rows, 3) // crm, catalog, sales — uma linha por módulo
    assert.isTrue(rows.every((r) => r.status === 'ENABLED' && r.enabled_at))
  })

  test('recusa módulos não licenciados, descontinuados, desconhecidos e os do núcleo', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client, ['crm'])
    const unlicensed = await http.post('/api/v1/tenant/modules/inventory/enable', {})
    unlicensed.assertStatus(409)
    assert.strictEqual(unlicensed.body().error.code, 'MODULE_NOT_LICENSED')
    // Uma dependência não licenciada também bloqueia o pedido com withDependencies.
    const viaDeps = await http.post('/api/v1/tenant/modules/sales/enable', {
      withDependencies: true,
    })
    viaDeps.assertStatus(409)
    assert.strictEqual(viaDeps.body().error.code, 'MODULE_NOT_LICENSED')
    assert.includeMembers(
      viaDeps.body().error.details.map((d: any) => d.message),
      ['sales', 'catalog']
    )
    assert.strictEqual((await statusOf(http)).crm, 'DISABLED') // nada ficou a meio

    ;(await http.post('/api/v1/tenant/modules/nada/enable', {})).assertStatus(404)
    const core = await http.post('/api/v1/tenant/modules/core/enable', {})
    assert.strictEqual(core.body().error.code, 'MODULE_ALWAYS_ON')
    ;(await http.post('/api/v1/tenant/modules/core/disable', {})).assertStatus(409)

    await new SyncRegistry(new LucidRegistryStore()).execute(
      TEST_MANIFESTS.filter((m) => m.code !== 'crm').map((m) => ({
        ...m,
        dependencies: m.dependencies.filter((d) => d.code !== 'crm'),
      }))
    )
    const deprecated = await http.post('/api/v1/tenant/modules/crm/enable', {})
    assert.strictEqual(deprecated.body().error.code, 'MODULE_DEPRECATED')
  })

  test('desactivar: bloqueia dependentes activos e nunca apaga o registo', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client)
    await http.post('/api/v1/tenant/modules/sales/enable', { withDependencies: true })
    const blocked = await http.post('/api/v1/tenant/modules/crm/disable', {})
    blocked.assertStatus(409)
    assert.strictEqual(blocked.body().error.code, 'DEPENDENTS_ENABLED')
    assert.deepEqual(
      blocked.body().error.details.map((d: any) => d.message),
      ['sales']
    )

    const off = await http.post('/api/v1/tenant/modules/sales/disable', {})
    off.assertStatus(200)
    assert.deepEqual(off.body().data.affectedFeatures, ['sales.quotes'])
    assert.strictEqual(off.body().data.module.status, 'DISABLED')
    ;(await http.post('/api/v1/tenant/modules/crm/disable', {})).assertStatus(200)
    ;(await http.post('/api/v1/tenant/modules/crm/disable', {})).assertStatus(200) // repetir é seguro

    // A linha mantém-se (histórico), apenas DISABLED; reactivar reutiliza-a.
    const rows = await tenantRows(tenant.id, 'tenant_modules')
    assert.lengthOf(rows, 3)
    assert.isTrue(rows.filter((r) => r.status === 'DISABLED').length >= 2)
    ;(await http.post('/api/v1/tenant/modules/crm/enable', {})).assertStatus(200)
    assert.lengthOf(await tenantRows(tenant.id, 'tenant_modules'), 3)
  })

  test('a activação exige module.manage', async ({ client }) => {
    const { tenant, operator } = await setup(client)
    const asOperator = api(client, tenant, operator)
    ;(await asOperator.post('/api/v1/tenant/modules/crm/enable', {})).assertStatus(403)
    ;(await asOperator.post('/api/v1/tenant/modules/crm/disable', {})).assertStatus(403)
    ;(await asOperator.put('/api/v1/tenant/features/crm.scoring', { override: null })).assertStatus(
      403
    )
  })

  test('falha de activação deixa ERROR e a repetição retoma sem duplicar sementes', async ({
    client,
    assert,
  }) => {
    const { tenant, admin } = await setup(client)
    const seeds = new Map<string, number>()
    let failOnce = true
    const activator = new CodeModuleActivator({
      crm: async (context: TenantContext) => {
        // Semente idempotente: chave por tenant+módulo.
        seeds.set(`crm:${context.tenantId}`, 1)
      },
      sales: async () => {
        if (failOnce) {
          failOnce = false
          throw new Error('segredo interno: não pode chegar ao tenant')
        }
      },
    })
    const enable = new EnableModule(
      new LucidTenantDatabase(),
      new LucidRegistryStore(),
      new LucidTenantModuleStore(),
      new BillingLicenceReader(),
      activator
    )
    const context = serviceTenantContext(tenant.id, 'teste')
    const failed = await capture(() => enable.execute(context, 'sales', { withDependencies: true }))
    assert.strictEqual((failed as any).code, 'MODULE_ACTIVATION_FAILED')
    assert.notInclude(JSON.stringify(failed), 'segredo')

    const list = new ListModules(
      new LucidTenantDatabase(),
      new LucidRegistryStore(),
      new LucidTenantModuleStore(),
      new BillingLicenceReader()
    )
    const mid = Object.fromEntries((await list.execute(context)).map((m) => [m.code, m]))
    assert.strictEqual(mid.sales.status, 'ERROR')
    assert.isNotNull(mid.sales.lastError)
    assert.notInclude(mid.sales.lastError ?? '', 'segredo')
    assert.strictEqual(mid.crm.status, 'ENABLED') // o progresso mantém-se
    assert.strictEqual(mid.catalog.status, 'ENABLED')

    const resumed = await enable.execute(context, 'sales', { withDependencies: true })
    assert.strictEqual(resumed.status, 'ENABLED')
    assert.isNull(resumed.lastError)
    assert.lengthOf(await tenantRows(tenant.id, 'tenant_modules'), 3)
    assert.strictEqual(seeds.size, 1)
    void admin
  })
})

test.group('módulos | funcionalidades', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.setup(async () => {
    await resetAuthState()
    await syncTestRegistry()
    return async () => {
      await deleteTestTenants()
      await deleteTestUsers()
    }
  })

  const features = async (http: ReturnType<typeof api>) =>
    Object.fromEntries(
      ((await http.get('/api/v1/context/features')).body().data as any[]).map((f) => [f.code, f])
    )

  test('acesso efectivo = licença AND módulo activo AND funcionalidade ligada', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client, ['crm', 'catalog', 'sales'])
    let f = await features(http)
    assert.isFalse(f['sales.quotes'].enabled)
    assert.strictEqual(f['sales.quotes'].reason, 'MODULE_DISABLED')
    assert.strictEqual(f['inventory.stock'].reason, 'NOT_LICENSED')

    await http.post('/api/v1/tenant/modules/sales/enable', { withDependencies: true })
    f = await features(http)
    assert.isTrue(f['sales.quotes'].enabled) // por omissão no módulo
    assert.isTrue(f['crm.contacts'].enabled)
    assert.isFalse(f['sales.discounts'].enabled)
    assert.strictEqual(f['sales.discounts'].reason, 'FEATURE_NOT_LICENSED') // extra: o plano não a inclui
    assert.isFalse(f['crm.scoring'].enabled)

    // GET /context traz os activos (só conveniência).
    const context = (await http.get('/api/v1/context')).body().data
    assert.includeMembers(context.modules, ['crm', 'catalog', 'sales', 'core'])
    assert.include(context.features, 'sales.quotes')
    assert.notInclude(context.features, 'sales.discounts')
  })

  test('override: liga o que o plano licencia, desliga o que vem por omissão, e nunca ultrapassa a licença', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client, ['crm', 'catalog', 'sales'], ['sales.discounts'])
    await http.post('/api/v1/tenant/modules/sales/enable', { withDependencies: true })

    // Licenciada mas desligada por omissão: precisa de override com motivo.
    assert.isFalse((await features(http))['sales.discounts'].enabled)
    const noReason = await http.put('/api/v1/tenant/features/sales.discounts', { override: true })
    noReason.assertStatus(422)
    ;(
      await http.put('/api/v1/tenant/features/sales.discounts', {
        override: true,
        reason: 'Piloto com a equipa comercial',
      })
    ).assertStatus(200)
    assert.isTrue((await features(http))['sales.discounts'].enabled)

    // Desliga uma funcionalidade por omissão.
    ;(
      await http.put('/api/v1/tenant/features/sales.quotes', {
        override: false,
        reason: 'Em revisão',
      })
    ).assertStatus(200)
    assert.isFalse((await features(http))['sales.quotes'].enabled)
    // null repõe o valor por omissão.
    ;(await http.put('/api/v1/tenant/features/sales.quotes', { override: null })).assertStatus(200)
    assert.isTrue((await features(http))['sales.quotes'].enabled)

    // Não licenciada: override a favor é recusado.
    const over = await http.put('/api/v1/tenant/features/crm.scoring', {
      override: true,
      reason: 'Quero testar',
    })
    over.assertStatus(409)
    assert.strictEqual(over.body().error.code, 'FEATURE_NOT_LICENSED')
    ;(
      await http.put('/api/v1/tenant/features/nada.x', { override: false, reason: 'x' })
    ).assertStatus(404)

    // Se a licença deixar de incluir a funcionalidade, o override antigo deixa de valer.
    await license(tenant, ['crm', 'catalog', 'sales'], [])
    const f = await features(http)
    assert.isFalse(f['sales.discounts'].enabled)
    assert.strictEqual(f['sales.discounts'].reason, 'FEATURE_NOT_LICENSED')
  })

  test('override expirado é ignorado; prazo no passado é recusado', async ({ client, assert }) => {
    const { tenant, http } = await setup(client, ['crm'])
    await http.post('/api/v1/tenant/modules/crm/enable', {})
    const past = await http.put('/api/v1/tenant/features/crm.contacts', {
      override: false,
      reason: 'x',
      expiresAt: '2020-01-01T00:00:00Z',
    })
    past.assertStatus(422)

    const base = new SetFeatureOverride(
      new LucidTenantDatabase(),
      new LucidRegistryStore(),
      new LucidTenantModuleStore(),
      new BillingLicenceReader(),
      { now: () => new Date('2026-01-01T00:00:00Z') }
    )
    const context = serviceTenantContext(tenant.id, 'teste')
    const until = new Date('2026-06-01T00:00:00Z')
    const off = await base.execute(context, 'crm.contacts', {
      override: false,
      reason: 'temporário',
      expiresAt: until,
    })
    assert.isFalse(off.enabled)
    const later = new ListModules(
      new LucidTenantDatabase(),
      new LucidRegistryStore(),
      new LucidTenantModuleStore(),
      new BillingLicenceReader(),
      { now: () => new Date('2026-07-01T00:00:00Z') }
    )
    const crm = (await later.execute(context)).find((m) => m.code === 'crm')!
    assert.isTrue(crm.features.find((f) => f.code === 'crm.contacts')!.enabled)
  })

  test('a API bloqueia uma funcionalidade desligada mesmo que o menu a mostre', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client, ['crm'])
    const middleware = new FeatureMiddleware()
    const ctx: any = { tenantContext: serviceTenantContext(tenant.id, 'teste') }
    const call = () => middleware.handle(ctx, async () => 'passou', { code: 'crm.contacts' })

    const blocked = await capture(call)
    assert.strictEqual((blocked as any).status, 403)
    assert.strictEqual((blocked as any).code, 'FEATURE_NOT_AVAILABLE')
    await http.post('/api/v1/tenant/modules/crm/enable', {})
    assert.strictEqual(await call(), 'passou')
    await http.post('/api/v1/tenant/modules/crm/disable', {})
    assert.strictEqual(((await capture(call)) as any).status, 403)
    const unknown = await capture(() =>
      middleware.handle(ctx, async () => 'passou', { code: 'nada.x' })
    )
    assert.strictEqual((unknown as any).status, 403) // desconhecida → nega
  })

  test('sem assinatura nada está licenciado (excepto o núcleo); suspensa desliga as funcionalidades', async ({
    client,
    assert,
  }) => {
    const { tenant, http } = await setup(client, ['crm'])
    await http.post('/api/v1/tenant/modules/crm/enable', {})
    assert.isTrue((await features(http))['crm.contacts'].enabled)
    await billingServices().setSubscriptionStatus.execute({
      tenantId: tenant.id,
      status: 'SUSPENDED',
    })
    const f = await features(http)
    assert.isFalse(f['crm.contacts'].enabled)
    assert.strictEqual(f['crm.contacts'].reason, 'NOT_LICENSED')
    // Reactivar a assinatura devolve o acesso sem perder o estado do módulo.
    await billingServices().setSubscriptionStatus.execute({ tenantId: tenant.id, status: 'ACTIVE' })
    assert.isTrue((await features(http))['crm.contacts'].enabled)
  })

  test('cada tenant vê e altera só os seus módulos', async ({ client, assert }) => {
    const a = await setup(client)
    const b = await setup(client)
    await a.http.post('/api/v1/tenant/modules/crm/enable', {})
    assert.strictEqual((await statusOf(a.http)).crm, 'ENABLED')
    assert.strictEqual((await statusOf(b.http)).crm, 'DISABLED')
    assert.lengthOf(await tenantRows(b.tenant.id, 'tenant_modules'), 0)
    // Selector alheio: 403 como "sem membership".
    ;(await api(client, b.tenant, a.admin).get('/api/v1/modules')).assertStatus(403)
    void moduleServices
  })
})
