import { test } from '@japa/runner'
import { iamServices } from '#core/permissions/index'
import { LucidTenantDatabase, serviceTenantContext } from '#core/tenancy/index'
import { settingsServices } from '#core/settings/index'
import { capture } from '#tests/support/capture'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { createActiveTenant, deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'

type Http = ReturnType<typeof api>

async function setup(client: any) {
  const tenant = await createActiveTenant()
  const admin = await newActor(client, tenant, true)
  const operator = await newActor(client, tenant)
  const http = api(client, tenant, admin)
  const org = (
    await http.post('/api/v1/organizations', {
      code: 'ORG-1',
      legalName: 'Empresa, Lda.',
      countryCode: 'AO',
      baseCurrency: 'AOA',
    })
  ).body().data
  const branch = (
    await http.post('/api/v1/organization-units', {
      organizationId: org.id,
      code: 'LUA',
      name: 'Luanda',
      type: 'BRANCH',
    })
  ).body().data
  return { tenant, admin, operator, http, org, branch }
}

const effective = async (http: Http, query = '') => {
  const response = await http.get(`/api/v1/settings/effective${query}`)
  response.assertStatus(200)
  return Object.fromEntries((response.body().data as any[]).map((s) => [s.key, s]))
}

test.group('configurações | API', (group) => {
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

  test('valor efectivo e origem em cada nível; repor herança remove o nível', async ({
    client,
    assert,
  }) => {
    const { http, org, branch, admin } = await setup(client)
    const q = `?organizationId=${org.id}&branchId=${branch.id}&moduleCode=sales`
    const key = 'ui.dateFormat'
    const level = async () => (await effective(http, q))[key]

    assert.strictEqual((await level()).source.level, 'DEFAULT')
    assert.strictEqual((await level()).value, 'dd/MM/yyyy')

    const put = (body: Record<string, unknown>) => http.put(`/api/v1/settings/${key}`, body)
    ;(await put({ scopeType: 'TENANT', value: 'yyyy-MM-dd' })).assertStatus(200)
    assert.strictEqual((await level()).source.level, 'TENANT')
    ;(await put({ scopeType: 'ORGANIZATION', scopeId: org.id, value: 'MM/dd/yyyy' })).assertStatus(
      200
    )
    assert.deepEqual((await level()).source, {
      level: 'ORGANIZATION',
      scopeId: org.id,
      moduleCode: null,
    })
    ;(await put({ scopeType: 'BRANCH', scopeId: branch.id, value: 'dd/MM/yyyy' })).assertStatus(200)
    assert.strictEqual((await level()).source.level, 'BRANCH')
    ;(await put({ scopeType: 'MODULE', moduleCode: 'sales', value: 'yyyy-MM-dd' })).assertStatus(
      200
    )
    assert.strictEqual((await level()).source.moduleCode, 'sales')
    ;(
      await put({
        scopeType: 'BRANCH',
        scopeId: branch.id,
        moduleCode: 'sales',
        value: 'MM/dd/yyyy',
      })
    ).assertStatus(200)
    const combo = await level()
    assert.deepEqual(combo.source, { level: 'BRANCH', scopeId: branch.id, moduleCode: 'sales' })
    assert.strictEqual(combo.value, 'MM/dd/yyyy')

    // Preferência pessoal: a mais específica.
    ;(await http.put(`/api/v1/me/settings/${key}`, { value: 'yyyy-MM-dd' })).assertStatus(200)
    const personal = await level()
    assert.strictEqual(personal.source.level, 'MEMBERSHIP')
    assert.strictEqual(personal.source.scopeId, admin.membershipId)

    // Repor a herança, um nível de cada vez.
    ;(await http.delete(`/api/v1/me/settings/${key}`)).assertStatus(204)
    assert.strictEqual((await level()).source.level, 'BRANCH')
    ;(
      await http.delete(
        `/api/v1/settings/${key}?scopeType=BRANCH&scopeId=${branch.id}&moduleCode=sales`
      )
    ).assertStatus(204)
    assert.strictEqual((await level()).source.moduleCode, 'sales')
    ;(await http.delete(`/api/v1/settings/${key}?scopeType=MODULE&moduleCode=sales`)).assertStatus(
      204
    )
    ;(await http.delete(`/api/v1/settings/${key}?scopeType=MODULE&moduleCode=sales`)).assertStatus(
      404
    )

    // Sem contexto de filial/módulo pedido, valem os níveis gerais.
    const general = (await effective(http, `?organizationId=${org.id}`))[key]
    assert.strictEqual(general.source.level, 'ORGANIZATION')
  })

  test('regras fiscais não admitem override pessoal, de filial ou de módulo', async ({
    client,
    assert,
  }) => {
    const { http, org, branch } = await setup(client)
    const key = 'tax.roundingMode'
    const personal = await http.put(`/api/v1/me/settings/${key}`, { value: 'HALF_EVEN' })
    personal.assertStatus(422)
    assert.strictEqual(personal.body().error.details[0].code, 'SCOPE_NOT_ALLOWED')
    ;(
      await http.put(`/api/v1/settings/${key}`, {
        scopeType: 'BRANCH',
        scopeId: branch.id,
        value: 'HALF_EVEN',
      })
    ).assertStatus(422)
    ;(
      await http.put(`/api/v1/settings/${key}`, {
        scopeType: 'MODULE',
        moduleCode: 'sales',
        value: 'HALF_EVEN',
      })
    ).assertStatus(422)
    ;(
      await http.put(`/api/v1/settings/${key}`, {
        scopeType: 'ORGANIZATION',
        scopeId: org.id,
        value: 'HALF_EVEN',
      })
    ).assertStatus(200)
    assert.strictEqual((await effective(http, `?organizationId=${org.id}`))[key].value, 'HALF_EVEN')
  })

  test('a preferência de idioma não altera imposto', async ({ client, assert }) => {
    const { http, org } = await setup(client)
    await http.post('/api/v1/tax-rates', {
      organizationId: org.id,
      code: 'IVA',
      name: 'IVA',
      rate: '14',
      validFrom: '2026-01-01',
      category: 'VAT',
    })
    const before = {
      fiscal: [
        (await effective(http))['tax.roundingMode'],
        (await effective(http))['tax.pricesIncludeTax'],
      ],
      rates: (await http.get('/api/v1/tax-rates')).body().data,
    }
    ;(
      await http.put('/api/v1/settings/ui.locale', { scopeType: 'TENANT', value: 'en' })
    ).assertStatus(200)
    ;(await http.put('/api/v1/me/settings/ui.locale', { value: 'pt-PT' })).assertStatus(200)
    assert.strictEqual((await effective(http))['ui.locale'].value, 'pt-PT')
    assert.deepEqual(
      [
        (await effective(http))['tax.roundingMode'],
        (await effective(http))['tax.pricesIncludeTax'],
      ],
      before.fiscal
    )
    assert.deepEqual((await http.get('/api/v1/tax-rates')).body().data, before.rates)
  })

  test('valida chave, valor, âmbito e referências; controla versões', async ({
    client,
    assert,
  }) => {
    const a = await setup(client)
    const b = await setup(client)
    const put = (body: Record<string, unknown>, key = 'ui.locale') =>
      a.http.put(`/api/v1/settings/${key}`, body)

    ;(await put({ scopeType: 'TENANT', value: 'klingon' })).assertStatus(422)
    ;(await put({ scopeType: 'TENANT', value: 'en' }, 'nao.existe')).assertStatus(404)
    ;(await put({ scopeType: 'ORGANIZATION', value: 'en' })).assertStatus(422) // falta scopeId
    // Organização ou filial de outro tenant: inexistentes aqui.
    const foreignOrg = await put({ scopeType: 'ORGANIZATION', scopeId: b.org.id, value: 'en' })
    foreignOrg.assertStatus(422)
    assert.strictEqual(foreignOrg.body().error.details[0].code, 'NOT_FOUND')
    ;(await put({ scopeType: 'BRANCH', scopeId: b.branch.id, value: 'en' })).assertStatus(422)
    // Uma unidade que não é filial também não serve de âmbito de filial.
    const dept = (
      await a.http.post('/api/v1/organization-units', {
        organizationId: a.org.id,
        code: 'FIN',
        name: 'Finanças',
        type: 'DEPARTMENT',
      })
    ).body().data
    ;(await put({ scopeType: 'BRANCH', scopeId: dept.id, value: 'en' })).assertStatus(422)
    // Filial de outra organização do mesmo tenant.
    const org2 = (
      await a.http.post('/api/v1/organizations', {
        code: 'ORG-2',
        legalName: 'Outra, Lda.',
        countryCode: 'AO',
        baseCurrency: 'AOA',
      })
    ).body().data
    const mismatch = await a.http.get(
      `/api/v1/settings/effective?organizationId=${org2.id}&branchId=${a.branch.id}`
    )
    mismatch.assertStatus(422)
    assert.strictEqual(mismatch.body().error.details[0].code, 'BRANCH_NOT_IN_ORGANIZATION')

    const first = await put({ scopeType: 'TENANT', value: 'en' })
    first.assertStatus(200)
    assert.strictEqual(first.body().data.version, 1)
    const noVersion = await put({ scopeType: 'TENANT', value: 'pt-PT' })
    noVersion.assertStatus(409)
    assert.strictEqual(noVersion.body().error.code, 'VERSION_REQUIRED')
    const stale = await put({ scopeType: 'TENANT', value: 'pt-PT', expectedVersion: 7 })
    stale.assertStatus(409)
    assert.strictEqual(stale.body().error.code, 'VERSION_CONFLICT')
    const ok = await put({ scopeType: 'TENANT', value: 'pt-PT', expectedVersion: 1 })
    ok.assertStatus(200)
    assert.strictEqual(ok.body().data.version, 2)

    // Cada tenant vê só os seus valores.
    assert.lengthOf((await a.http.get('/api/v1/settings')).body().data, 1)
    assert.lengthOf((await b.http.get('/api/v1/settings')).body().data, 0)
    assert.strictEqual((await effective(b.http))['ui.locale'].source.level, 'DEFAULT')
  })

  test('permissões: leitura, escrita e valores efectivos', async ({ client, assert }) => {
    const { tenant, operator, http } = await setup(client)
    const asOperator = api(client, tenant, operator)
    ;(await asOperator.get('/api/v1/settings/effective')).assertStatus(200)
    ;(await asOperator.put('/api/v1/me/settings/ui.locale', { value: 'en' })).assertStatus(200)
    for (const [method, url, body] of [
      ['get', '/api/v1/settings'],
      ['get', '/api/v1/tax-rates'],
      ['get', '/api/v1/units'],
      ['get', '/api/v1/sequences'],
      ['put', '/api/v1/settings/ui.locale', { scopeType: 'TENANT', value: 'en' }],
      ['post', '/api/v1/tax-rates', {}],
      ['post', '/api/v1/units', {}],
      ['post', '/api/v1/sequences', {}],
      ['post', '/api/v1/sequences/preview', {}],
    ] as const) {
      const response = await (asOperator as any)[method](url, body)
      assert.strictEqual(response.status(), 403, `${method} ${url}`)
    }
    const role = (
      await http.post('/api/v1/roles', {
        code: 'leitor_cfg',
        name: 'Leitor de configuração',
        permissionCodes: ['settings.read'],
      })
    ).body().data
    await http.post('/api/v1/role-assignments', {
      membershipId: operator.membershipId,
      roleId: role.id,
    })
    ;(await asOperator.get('/api/v1/tax-rates')).assertStatus(200)
    ;(await asOperator.post('/api/v1/tax-rates', {})).assertStatus(403)
  })

  test('as alterações ficam na auditoria (com antes e depois)', async ({ client, assert }) => {
    const { http } = await setup(client)
    await http.put('/api/v1/settings/ui.locale', { scopeType: 'TENANT', value: 'en' })
    await http.put('/api/v1/settings/ui.locale', {
      scopeType: 'TENANT',
      value: 'pt-PT',
      expectedVersion: 1,
    })
    const logs = (
      await http.get('/api/v1/audit-logs?resourceType=setting_values&action=setting_values.UPDATE')
    ).body().data as any[]
    assert.lengthOf(logs, 1)
    assert.strictEqual(logs[0].before.value, 'en')
    assert.strictEqual(logs[0].after.value, 'pt-PT')
  })
})

test.group('impostos e unidades', (group) => {
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

  const rate = (orgId: string, extra: Record<string, unknown> = {}) => ({
    organizationId: orgId,
    code: 'IVA',
    name: 'IVA normal',
    rate: '14',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    category: 'VAT',
    ...extra,
  })

  test('períodos sobrepostos para o mesmo código são rejeitados; adjacentes e outras organizações não', async ({
    client,
    assert,
  }) => {
    const { http, org } = await setup(client)
    ;(await http.post('/api/v1/tax-rates', rate(org.id))).assertStatus(201)
    const overlap = await http.post(
      '/api/v1/tax-rates',
      rate(org.id, { validFrom: '2026-12-31', validTo: null })
    )
    overlap.assertStatus(409)
    assert.strictEqual(overlap.body().error.code, 'TAX_RATE_OVERLAP')
    ;(
      await http.post(
        '/api/v1/tax-rates',
        rate(org.id, { validFrom: '2025-06-01', validTo: '2026-06-30' })
      )
    ).assertStatus(409)
    // Dentro de outro código ou noutra organização: livre. Adjacente: ok.
    ;(await http.post('/api/v1/tax-rates', rate(org.id, { code: 'IS' }))).assertStatus(201)
    const next = await http.post(
      '/api/v1/tax-rates',
      rate(org.id, { rate: '15', validFrom: '2027-01-01', validTo: null })
    )
    next.assertStatus(201)
    const org2 = (
      await http.post('/api/v1/organizations', {
        code: 'ORG-2',
        legalName: 'Outra, Lda.',
        countryCode: 'AO',
        baseCurrency: 'AOA',
      })
    ).body().data
    ;(await http.post('/api/v1/tax-rates', rate(org2.id))).assertStatus(201)

    // Estender o fim de validade para a sobrepor ao seguinte também é recusado.
    const first = (await http.get(`/api/v1/tax-rates?organizationId=${org.id}&code=IVA`)).body()
      .data[0]
    const extend = await http.patch(`/api/v1/tax-rates/${first.id}`, {
      expectedVersion: first.version,
      validTo: '2027-06-30',
    })
    extend.assertStatus(409)
    assert.strictEqual(extend.body().error.code, 'TAX_RATE_OVERLAP')
  })

  test('criações concorrentes sobrepostas: só uma vence', async ({ client, assert }) => {
    const { http, org } = await setup(client)
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) =>
        http.post(
          '/api/v1/tax-rates',
          rate(org.id, { rate: String(10 + i), validFrom: `2026-0${i}-01`, validTo: null })
        )
      )
    )
    const statuses = results.map((r) => r.status()).sort()
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409])
  })

  test('a taxa é imutável; zero exige motivo; filtro por data', async ({ client, assert }) => {
    const { http, org } = await setup(client)
    const created = (await http.post('/api/v1/tax-rates', rate(org.id))).body().data
    assert.strictEqual(created.rate, '14.0000') // decimal como string
    const patched = await http.patch(`/api/v1/tax-rates/${created.id}`, {
      expectedVersion: 1,
      rate: '99',
      code: 'XX',
      validFrom: '2000-01-01',
      name: 'IVA (renomeado)',
    })
    patched.assertStatus(200)
    assert.strictEqual(patched.body().data.rate, '14.0000')
    assert.strictEqual(patched.body().data.code, 'IVA')
    assert.strictEqual(patched.body().data.validFrom, '2026-01-01')
    assert.strictEqual(patched.body().data.name, 'IVA (renomeado)')
    ;(
      await http.patch(`/api/v1/tax-rates/${created.id}`, { expectedVersion: 1, name: 'x' })
    ).assertStatus(409)

    const zero = await http.post('/api/v1/tax-rates', rate(org.id, { code: 'ISENTO', rate: '0' }))
    zero.assertStatus(422)
    ;(
      await http.post(
        '/api/v1/tax-rates',
        rate(org.id, { code: 'ISENTO', rate: '0', exemptionReason: 'Art. 12.º' })
      )
    ).assertStatus(201)
    ;(
      await http.post('/api/v1/tax-rates', rate(org.id, { code: 'BAD', validTo: '2025-01-01' }))
    ).assertStatus(422)
    ;(
      await http.post('/api/v1/tax-rates', rate('00000000-0000-4000-8000-000000000000'))
    ).assertStatus(422)

    assert.lengthOf((await http.get(`/api/v1/tax-rates?on=2026-06-01&code=IVA`)).body().data, 1)
    assert.lengthOf((await http.get(`/api/v1/tax-rates?on=2025-06-01&code=IVA`)).body().data, 0)
    ;(await http.get('/api/v1/tax-rates?on=ontem')).assertStatus(422)
  })

  test('unidades: base e derivadas, conversão exacta e só entre dimensões compatíveis', async ({
    client,
    assert,
  }) => {
    const { http } = await setup(client)
    const unit = async (body: Record<string, unknown>) => http.post('/api/v1/units', body)
    const kg = (
      await unit({ code: 'KG', name: 'Quilograma', dimension: 'MASS', precision: 3 })
    ).body().data
    ;(
      await unit({
        code: 'G',
        name: 'Grama',
        dimension: 'MASS',
        precision: 0,
        baseUnitId: kg.id,
        conversionFactor: '0.001',
      })
    ).assertStatus(201)
    ;(
      await unit({
        code: 'T',
        name: 'Tonelada',
        dimension: 'MASS',
        precision: 3,
        baseUnitId: kg.id,
        conversionFactor: '1000',
      })
    ).assertStatus(201)
    const litre = (
      await unit({ code: 'L', name: 'Litro', dimension: 'VOLUME', precision: 3 })
    ).body().data

    const convert = async (from: string, to: string, quantity: string) =>
      http.get(`/api/v1/units/convert?from=${from}&to=${to}&quantity=${quantity}`)
    assert.strictEqual((await convert('KG', 'G', '1.5')).body().data.result, '1500')
    assert.strictEqual((await convert('G', 'T', '2500000')).body().data.result, '2.500')
    assert.strictEqual((await convert('T', 'G', '0.0005')).body().data.result, '500')
    const bad = await convert('KG', 'L', '1')
    bad.assertStatus(422)
    assert.strictEqual(bad.body().error.details[0].code, 'INCOMPATIBLE_DIMENSIONS')
    ;(await convert('KG', 'XX', '1')).assertStatus(404)
    ;(await convert('KG', 'G', '-1')).assertStatus(422)

    // Regras da estrutura.
    const dup = await unit({ code: 'KG', name: 'Outro', dimension: 'MASS', precision: 0 })
    dup.assertStatus(409)
    assert.strictEqual(dup.body().error.code, 'UNIT_CODE_TAKEN')
    const g = ((await http.get('/api/v1/units')).body().data as any[]).find((u) => u.code === 'G')
    // Cadeias: a base de uma derivada tem de ser uma unidade base.
    ;(
      await unit({
        code: 'MG',
        name: 'Miligrama',
        dimension: 'MASS',
        precision: 3,
        baseUnitId: g.id,
        conversionFactor: '0.001',
      })
    ).assertStatus(422)
    // Outra dimensão, e base sem factor / factor sem base.
    ;(
      await unit({
        code: 'ML',
        name: 'Mililitro',
        dimension: 'MASS',
        precision: 0,
        baseUnitId: litre.id,
        conversionFactor: '0.001',
      })
    ).assertStatus(422)
    ;(
      await unit({ code: 'X1', name: 'x', dimension: 'MASS', precision: 0, baseUnitId: kg.id })
    ).assertStatus(422)
    ;(
      await unit({ code: 'X2', name: 'x', dimension: 'MASS', precision: 0, conversionFactor: '2' })
    ).assertStatus(422)
    ;(await unit({ code: 'X3', name: 'x', dimension: 'MASS', precision: 9 })).assertStatus(422)
    ;(
      await unit({
        code: 'X4',
        name: 'x',
        dimension: 'MASS',
        precision: 0,
        baseUnitId: kg.id,
        conversionFactor: '0',
      })
    ).assertStatus(422)

    // A precisão pode mudar (a conversão passa a arredondar de outra forma); a dimensão/factor não.
    const changed = await http.patch(`/api/v1/units/${g.id}`, {
      expectedVersion: g.version,
      precision: 2,
      dimension: 'VOLUME',
      conversionFactor: '5',
    })
    changed.assertStatus(200)
    assert.strictEqual(changed.body().data.precision, 2)
    assert.strictEqual(changed.body().data.dimension, 'MASS')
    assert.strictEqual(changed.body().data.factor, '0.001000')
    assert.strictEqual((await convert('KG', 'G', '1.5')).body().data.result, '1500.00')
  })
})

test.group('sequências', (group) => {
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

  const uow = new LucidTenantDatabase()
  const issue = (
    tenantId: string,
    input: {
      organizationId: string
      branchId?: string | null
      documentType?: string
      series?: string
      date?: Date
    }
  ) =>
    uow.run(
      (scope) =>
        settingsServices().sequenceIssuer.issue(scope, {
          documentType: 'INVOICE',
          series: 'A',
          date: new Date('2026-03-15T10:00:00Z'),
          ...input,
        }),
      serviceTenantContext(tenantId, 'teste')
    )

  const create = (http: Http, body: Record<string, unknown>) =>
    http.post('/api/v1/sequences', {
      documentType: 'INVOICE',
      series: 'A',
      prefixTemplate: 'FT {SERIES}/{YYYY}/',
      ...body,
    })

  test('100 emissões concorrentes produzem números distintos e contíguos', async ({
    client,
    assert,
  }) => {
    const { tenant, http, org } = await setup(client)
    ;(await create(http, { organizationId: org.id })).assertStatus(201)
    const results = await Promise.all(
      Array.from({ length: 100 }, () => issue(tenant.id, { organizationId: org.id }))
    )
    const numbers = results.map((r) => r.number)
    assert.lengthOf(new Set(numbers), 100)
    const values = results.map((r) => Number(r.value)).sort((a, b) => a - b)
    assert.deepEqual(
      values,
      Array.from({ length: 100 }, (_, i) => i + 1)
    )
    assert.include(numbers, 'FT A/2026/000001')
    assert.include(numbers, 'FT A/2026/000100')
    const [seq] = (await http.get('/api/v1/sequences')).body().data
    assert.strictEqual(seq.nextValue, '101')
  })

  test('um número emitido nunca se reutiliza; se a transacção anular, volta (sem lacunas)', async ({
    client,
    assert,
  }) => {
    const { tenant, http, org } = await setup(client)
    ;(await create(http, { organizationId: org.id })).assertStatus(201)
    const first = await issue(tenant.id, { organizationId: org.id })
    // O documento é "cancelado" depois de confirmado: o número não volta.
    const second = await issue(tenant.id, { organizationId: org.id })
    assert.deepEqual([first.value, second.value], ['1', '2'])

    // Falha dentro da transacção do documento: o número é devolvido.
    const failed = await capture(() =>
      uow.run(
        async (scope) => {
          await settingsServices().sequenceIssuer.issue(scope, {
            organizationId: org.id,
            documentType: 'INVOICE',
            series: 'A',
            date: new Date('2026-03-15T00:00:00Z'),
          })
          throw new Error('o documento não foi gravado')
        },
        serviceTenantContext(tenant.id, 'teste')
      )
    )
    assert.match((failed as Error).message, /não foi gravado/)
    const third = await issue(tenant.id, { organizationId: org.id })
    assert.strictEqual(third.value, '3')
  })

  test('escolhe a sequência da filial e o período mais específico; sem configuração falha', async ({
    client,
    assert,
  }) => {
    const { tenant, http, org, branch } = await setup(client)
    ;(
      await create(http, { organizationId: org.id, period: 'ALL', prefixTemplate: 'ALL/' })
    ).assertStatus(201)
    ;(
      await create(http, { organizationId: org.id, period: '2026', prefixTemplate: 'Y{YY}/' })
    ).assertStatus(201)
    ;(
      await create(http, { organizationId: org.id, period: '2026-03', prefixTemplate: 'M{MM}/' })
    ).assertStatus(201)
    ;(
      await create(http, {
        organizationId: org.id,
        branchId: branch.id,
        period: 'ALL',
        prefixTemplate: '{BRANCH}-{ORG}-',
      })
    ).assertStatus(201)

    const march = await issue(tenant.id, { organizationId: org.id })
    assert.strictEqual(march.number, 'M03/000001')
    const june = await issue(tenant.id, {
      organizationId: org.id,
      date: new Date('2026-06-10T00:00:00Z'),
    })
    assert.strictEqual(june.number, 'Y26/000001')
    const y2027 = await issue(tenant.id, {
      organizationId: org.id,
      date: new Date('2027-01-10T00:00:00Z'),
    })
    assert.strictEqual(y2027.number, 'ALL/000001')
    const lua = await issue(tenant.id, { organizationId: org.id, branchId: branch.id })
    assert.strictEqual(lua.number, 'LUA-ORG-1-000001')

    const none = await capture(() =>
      issue(tenant.id, { organizationId: org.id, documentType: 'RECEIPT' })
    )
    assert.strictEqual((none as any).code, 'SEQUENCE_NOT_CONFIGURED')
    const otherSeries = await capture(() =>
      issue(tenant.id, { organizationId: org.id, series: 'B' })
    )
    assert.strictEqual((otherSeries as any).code, 'SEQUENCE_NOT_CONFIGURED')
  })

  test('as sequências são por organização e por tenant: não se misturam', async ({
    client,
    assert,
  }) => {
    const a = await setup(client)
    const b = await setup(client)
    ;(await create(a.http, { organizationId: a.org.id })).assertStatus(201)
    ;(await create(b.http, { organizationId: b.org.id })).assertStatus(201)
    await issue(a.tenant.id, { organizationId: a.org.id })
    await issue(a.tenant.id, { organizationId: a.org.id })
    const fromB = await issue(b.tenant.id, { organizationId: b.org.id })
    assert.strictEqual(fromB.value, '1')
    // Pedir a sequência de A com o contexto de B não a encontra.
    const crossed = await capture(() => issue(b.tenant.id, { organizationId: a.org.id }))
    assert.strictEqual((crossed as any).code, 'SEQUENCE_NOT_CONFIGURED')
    // Referências de outro tenant na criação são recusadas.
    ;(await create(a.http, { organizationId: b.org.id, series: 'Z' })).assertStatus(422)
    ;(
      await create(a.http, { organizationId: a.org.id, series: 'Z', branchId: b.branch.id })
    ).assertStatus(422)
  })

  test('gestão: duplicados, validação, próximo número só sobe e pré-visualização não consome', async ({
    client,
    assert,
  }) => {
    const { http, org, branch } = await setup(client)
    const created = await create(http, { organizationId: org.id, nextValue: '41', padding: 4 })
    created.assertStatus(201)
    const seq = created.body().data
    assert.strictEqual(seq.nextValue, '41')
    ;(await create(http, { organizationId: org.id })).assertStatus(409)

    for (const bad of [
      { series: 'Z', prefixTemplate: '{EVAL}' },
      { series: 'Z', prefixTemplate: 'x'.repeat(101) },
      { series: 'Z', padding: 13 },
      { series: 'Z', period: '2026-13' },
      { series: 'Z', nextValue: '0' },
      { series: 'Z', nextValue: '1.5' },
      { series: 'Z', documentType: 'fatura' },
    ]) {
      ;(await create(http, { organizationId: org.id, ...bad })).assertStatus(422)
    }

    const preview = await http.post('/api/v1/sequences/preview', {
      organizationId: org.id,
      branchId: branch.id,
      series: 'A',
      prefixTemplate: '{BRANCH}/{YYYY}/',
      padding: 5,
      nextValue: '7',
      date: '2026-03-15T00:00:00Z',
    })
    preview.assertStatus(200)
    assert.strictEqual(preview.body().data.example, 'LUA/2026/00007')
    assert.strictEqual((await http.get('/api/v1/sequences')).body().data[0].nextValue, '41')
    ;(
      await http.post('/api/v1/sequences/preview', {
        organizationId: org.id,
        series: 'A',
        prefixTemplate: '{X}',
      })
    ).assertStatus(422)

    const lower = await http.patch(`/api/v1/sequences/${seq.id}`, {
      expectedVersion: 1,
      nextValue: '10',
    })
    lower.assertStatus(422)
    assert.strictEqual(lower.body().error.details[0].code, 'NEXT_VALUE_DECREASE')
    const raised = await http.patch(`/api/v1/sequences/${seq.id}`, {
      expectedVersion: 1,
      nextValue: '100',
      prefixTemplate: 'NF-',
    })
    raised.assertStatus(200)
    assert.strictEqual(raised.body().data.nextValue, '100')
    ;(
      await http.patch(`/api/v1/sequences/${seq.id}`, { expectedVersion: 1, padding: 6 })
    ).assertStatus(409)
    // Identidade imutável: tipo/série/período não mudam por PATCH.
    const same = await http.patch(`/api/v1/sequences/${seq.id}`, {
      expectedVersion: 2,
      series: 'ZZ',
      documentType: 'RECEIPT',
    })
    same.assertStatus(200)
    assert.strictEqual(same.body().data.series, 'A')
    assert.strictEqual(same.body().data.documentType, 'INVOICE')
  })
})
