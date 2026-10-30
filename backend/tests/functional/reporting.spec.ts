import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { iamServices } from '#core/permissions/index'
import { documentServices } from '#modules/documents/index'
import { reportingServices } from '#modules/reporting/index'
import { deleteTestUsers, resetAuthState } from '#tests/support/auth_fixture'
import { deleteTestTenants } from '#tests/support/membership_fixture'
import { api, newActor } from '#tests/support/api_fixture'
import { buildWorld, type World } from '#tests/support/matrix_fixture'

type Http = ReturnType<typeof api>

async function must<T>(response: { status(): number; body(): any }, status: number): Promise<T> {
  if (response.status() !== status) {
    throw new Error(
      `Esperado ${status}, obtido ${response.status()}: ${JSON.stringify(response.body())}`
    )
  }
  return response.body().data as T
}

const code = (r: any) => r.body().error.details?.[0]?.code ?? r.body().error.code

const owner = <T>(sql: string, world: World) =>
  db.connection('owner').transaction(async (trx) => {
    await trx.rawQuery("select set_config('app.tenant_id', ?, true)", [world.tenant.id])
    return (await trx.rawQuery(sql)).rows as T[]
  })

/** Soma exacta de decimais em texto (4 casas), sem passar por float. */
const sum = (values: string[]): string => {
  const total = values.reduce((acc, v) => {
    const [i = '0', f = ''] = v.replace('-', '').split('.')
    const n = BigInt(i) * 10000n + BigInt((f + '0000').slice(0, 4))
    return acc + (v.startsWith('-') ? -n : n)
  }, 0n)
  const abs = total < 0n ? -total : total
  return `${total < 0n ? '-' : ''}${abs / 10000n}.${String(abs % 10000n).padStart(4, '0')}`
}

let cached: { a: World; b: World } | undefined
async function worlds(client: any) {
  if (!cached) {
    await iamServices().syncCatalog.execute()
    await resetAuthState()
    cached = { a: await buildWorld(client, 'A'), b: await buildWorld(client, 'B') }
  }
  return cached
}

async function memberWith(client: any, world: World, permissions: string[]) {
  // Cada pessoa nova inicia sessão: sem isto o limite de tentativas de início de sessão responde 429.
  await resetAuthState()
  const actor = await newActor(client, world.tenant)
  const role = await must<{ id: string }>(
    await world.http.post('/api/v1/roles', {
      code: `r_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Papel de teste',
      permissionCodes: permissions,
    }),
    201
  )
  const assignment = await must<{ id: string }>(
    await world.http.post('/api/v1/role-assignments', {
      membershipId: actor.membershipId,
      roleId: role.id,
    }),
    201
  )
  return {
    actor,
    http: api(client, world.tenant, actor),
    roleId: role.id,
    assignmentId: assignment.id,
  }
}

const READER = ['report.read', 'invoice.read', 'order.read', 'payment.read']

const detail = (select: string[], extra: Record<string, unknown> = {}) => ({ select, ...extra })

let seq = 0
const newReport = (
  http: Http,
  datasetCode: string,
  query: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) =>
  http.post('/api/v1/reports', {
    code: `rel_${Date.now().toString(36)}_${seq++}`,
    name: 'Relatório de teste',
    datasetCode,
    query,
    ...extra,
  })

async function publishedReport(
  http: Http,
  datasetCode: string,
  query: Record<string, unknown>,
  visibility: 'PRIVATE' | 'TENANT' = 'TENANT'
) {
  const created = await must<{ id: string }>(
    await newReport(http, datasetCode, query, { visibility }),
    201
  )
  await must(await http.post(`/api/v1/reports/${created.id}/publish`, {}), 200)
  return created.id
}

const run = (http: Http, id: string, body: Record<string, unknown> = {}) =>
  http.post(`/api/v1/reports/${id}/run`, body)

test.group('relatórios | datasets, totais e SQL declarativo', (group) => {
  group.setup(async () => {
    await iamServices().syncCatalog.execute()
  })
  group.each.timeout(240_000)

  test('os datasets documentam fórmulas e só aparecem a quem pode lê-los, com os campos visíveis', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const all = await must<any[]>(await a.http.get('/api/v1/datasets'), 200)
    assert.deepEqual(all.map((d) => d.code).sort(), [
      'payments_received',
      'sales_documents',
      'sales_orders',
    ])
    const sales = all.find((d) => d.code === 'sales_documents')
    assert.isTrue(
      sales.documentation.some((l: string) => l.includes('facturas emitidas − notas de crédito'))
    )
    assert.isTrue(
      all
        .find((d) => d.code === 'payments_received')
        .documentation.some((l: string) => l.includes('INBOUND'))
    )

    const onlyInvoices = await memberWith(client, a, ['report.read', 'invoice.read'])
    const visible = await must<any[]>(await onlyInvoices.http.get('/api/v1/datasets'), 200)
    assert.deepEqual(
      visible.map((d) => d.code),
      ['sales_documents']
    )
    // Quem não tem report.read nem sequer entra.
    const nobody = await api(client, a.tenant, a.operator).get('/api/v1/datasets')
    assert.equal(nobody.status(), 403)
    // O campo sensível só aparece a quem pode gerir o crédito.
    const withOrders = await memberWith(client, a, ['report.read', 'order.read'])
    const orders = (await must<any[]>(await withOrders.http.get('/api/v1/datasets'), 200)).find(
      (d) => d.code === 'sales_orders'
    )
    assert.notInclude(
      orders.fields.map((f: any) => f.code),
      'credit_reservation'
    )
    const admin = (all.find((d) => d.code === 'sales_orders') as any).fields.map((f: any) => f.code)
    assert.include(admin, 'credit_reservation')
  })

  test('vendas facturadas = facturas emitidas − notas de crédito, e o total do cartão coincide com a listagem', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const listing = await publishedReport(
      a.http,
      'sales_documents',
      detail(['kind', 'number', 'issued_on', 'currency', 'amount'])
    )
    const card = await publishedReport(a.http, 'sales_documents', {
      groupBy: ['currency'],
      measures: [
        { fn: 'sum', field: 'amount', alias: 'total' },
        { fn: 'count', alias: 'n' },
      ],
      sort: [{ field: 'currency', dir: 'asc' }],
    })
    const filters = [{ field: 'issued_on', op: 'gte', value: '2000-01-01' }]
    const rows = await must<any>(await run(a.http, listing, { filters, limit: 500 }), 200)
    const cardRows = await must<any>(await run(a.http, card, { filters }), 200)
    assert.isAbove(rows.rows.length, 1)
    assert.isTrue(rows.rows.some((r: any) => r.kind === 'CREDIT_NOTE' && r.amount.startsWith('-')))
    for (const line of cardRows.rows) {
      const own = rows.rows.filter((r: any) => r.currency === line.currency)
      assert.equal(line.total, sum(own.map((r: any) => r.amount)), `total ${line.currency}`)
      assert.equal(line.n, own.length)
    }
    assert.equal(cardRows.total, cardRows.rows.length)
    // Facturas − créditos, conferido contra as próprias listagens da API.
    const invoices = await must<any[]>(await a.http.get('/api/v1/invoices?limit=200'), 200)
    const issued = invoices.filter((i) => i.status === 'ISSUED' || i.status === 'CREDITED')
    const kinds = rows.rows
    assert.equal(kinds.filter((r: any) => r.kind === 'INVOICE').length, issued.length)
    assert.equal(
      sum(kinds.filter((r: any) => r.kind === 'INVOICE').map((r: any) => r.amount)),
      sum(issued.map((i) => i.totals.total))
    )
    // Os rascunhos nunca contam.
    assert.isFalse(
      invoices.some(
        (i) => i.status === 'DRAFT' && kinds.some((r: any) => r.number === i.number && i.number)
      )
    )
    assert.property(cardRows, 'asOf')
  })

  test('os mesmos filtros dão o mesmo universo em cartão e em listagem; paginação consistente', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const listing = await publishedReport(a.http, 'sales_documents', detail(['number', 'amount']))
    const count = await publishedReport(a.http, 'sales_documents', {
      measures: [{ fn: 'count', alias: 'n' }],
    })
    const filters = [{ field: 'kind', op: 'eq', value: 'INVOICE' }]
    const first = await must<any>(await run(a.http, listing, { filters, limit: 1, offset: 0 }), 200)
    const totalCard = await must<any>(await run(a.http, count, { filters }), 200)
    assert.equal(first.total, totalCard.rows[0].n)
    assert.lengthOf(first.rows, 1)
    const second = await must<any>(
      await run(a.http, listing, { filters, limit: 1, offset: 1 }),
      200
    )
    assert.notEqual(second.rows[0]?.number, first.rows[0].number)
    const none = await must<any>(
      await run(a.http, count, {
        filters: [
          { field: 'kind', op: 'eq', value: 'CREDIT_NOTE' },
          { field: 'amount', op: 'gt', value: '1000000' },
        ],
      }),
      200
    )
    assert.equal(none.rows[0].n, 0)
  })

  test('recebimentos = pagamentos de entrada confirmados, nunca vendas', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const id = await publishedReport(a.http, 'payments_received', {
      groupBy: ['currency'],
      measures: [{ fn: 'sum', field: 'amount', alias: 'total' }],
    })
    const result = await must<any>(await run(a.http, id), 200)
    const payments = await must<any[]>(await a.http.get('/api/v1/payments?limit=200'), 200)
    const confirmedIn = payments.filter(
      (p) => p.direction === 'INBOUND' && p.status === 'CONFIRMED'
    )
    assert.isAbove(confirmedIn.length, 0)
    assert.equal(result.rows[0].total, sum(confirmedIn.map((p) => p.amount)))
  })

  test('sem SQL livre: nomes, operadores e valores maliciosos são recusados ou inertes', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const preview = (query: Record<string, unknown>) =>
      a.http.post('/api/v1/reports/preview', { datasetCode: 'sales_documents', query })
    for (const query of [
      detail(['number; drop table invoices']),
      detail(['number'], { filters: [{ field: 'number) or (1=1', op: 'eq', value: 'x' }] }),
      detail(['number'], { filters: [{ field: 'number', op: 'eq; --', value: 'x' }] }),
      detail(['number'], { sort: [{ field: 'number', dir: 'asc; select 1' }] }),
      { measures: [{ fn: 'count', alias: 'n"; drop table x; --' }] },
      { groupBy: ['(select 1)'], measures: [{ fn: 'count', alias: 'n' }] },
    ]) {
      const r = await preview(query)
      assert.equal(r.status(), 422, JSON.stringify(query))
    }
    assert.equal(
      (
        await a.http.post('/api/v1/reports/preview', {
          datasetCode: 'tabela_qualquer',
          query: detail(['x']),
        })
      ).status(),
      422
    )
    // Um valor malicioso é só um texto: não casa com nada e a tabela continua lá.
    const inert = await must<any>(
      await preview(
        detail(['number'], {
          filters: [{ field: 'number', op: 'contains', value: "x'); drop table invoices; --" }],
        })
      ),
      200
    )
    assert.equal(inert.total, 0)
    assert.isAbove((await owner<any>('select count(*)::int as n from invoices', a))[0].n, 0)
  })

  test('campos sensíveis saem do resultado; filtrar ou medir por eles é recusado', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const reader = await memberWith(client, a, ['report.read', 'report.design', 'order.read'])
    const admin = await publishedReport(
      a.http,
      'sales_orders',
      detail(['number', 'total', 'credit_reservation'])
    )
    const adminResult = await must<any>(await run(a.http, admin), 200)
    assert.include(
      adminResult.columns.map((c: any) => c.code),
      'credit_reservation'
    )
    assert.deepEqual(adminResult.omittedFields, [])
    const same = await must<any>(await run(reader.http, admin), 200)
    assert.notInclude(
      same.columns.map((c: any) => c.code),
      'credit_reservation'
    )
    assert.deepEqual(same.omittedFields, ['credit_reservation'])
    assert.notProperty(same.rows[0], 'credit_reservation')
    for (const query of [
      detail(['number'], { filters: [{ field: 'credit_reservation', op: 'gt', value: '0' }] }),
      { measures: [{ fn: 'sum', field: 'credit_reservation', alias: 's' }] },
      { groupBy: ['credit_reservation'], measures: [{ fn: 'count', alias: 'n' }] },
    ]) {
      const r = await reader.http.post('/api/v1/reports/preview', {
        datasetCode: 'sales_orders',
        query,
      })
      assert.equal(code(r), 'FIELD_NOT_ALLOWED', JSON.stringify(query))
    }
  })

  test('campos escondidos por política ABAC também saem do resultado', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const member = await memberWith(client, a, ['report.read', 'invoice.read'])
    const id = await publishedReport(a.http, 'sales_documents', detail(['number', 'amount', 'tax']))
    const policy = await must<{ id: string; version: number }>(
      await a.http.post('/api/v1/access-policies', {
        name: 'Esconder o total das vendas',
        resource: 'invoice',
        action: 'read',
        effect: 'ALLOW',
        status: 'ACTIVE',
        fieldRules: [{ field: 'amount', mode: 'HIDDEN' }],
      }),
      201
    )
    try {
      const hidden = await must<any>(await run(member.http, id), 200)
      assert.notInclude(
        hidden.columns.map((c: any) => c.code),
        'amount'
      )
      assert.deepEqual(hidden.omittedFields, ['amount'])
      const r = await member.http.post(`/api/v1/reports/${id}/run`, {
        filters: [{ field: 'amount', op: 'gt', value: '1' }],
      })
      assert.equal(code(r), 'FIELD_NOT_ALLOWED')
    } finally {
      await a.http.patch(`/api/v1/access-policies/${policy.id}`, {
        expectedVersion: policy.version,
        status: 'DISABLED',
      })
    }
    const back = await must<any>(await run(member.http, id), 200)
    assert.include(
      back.columns.map((c: any) => c.code),
      'amount'
    )
  })

  test('sem a permissão do dataset não se corre nada, mesmo com report.read', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const id = await publishedReport(a.http, 'payments_received', detail(['amount']))
    const noPayments = await memberWith(client, a, ['report.read', 'invoice.read'])
    const r = await run(noPayments.http, id)
    assert.equal(r.status(), 403)
    assert.equal(
      (
        await noPayments.http.post('/api/v1/reports/preview', {
          datasetCode: 'payments_received',
          query: detail(['amount']),
        })
      ).status(),
      403
    )
  })
})

test.group('relatórios | ciclo de vida e painéis', (group) => {
  group.each.timeout(240_000)

  test('rascunho é do dono; publicado e da organização vê-se; publicado é imutável; duplicar cria rascunho', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const reader = await memberWith(client, a, READER)
    const designer = await memberWith(client, a, [...READER, 'report.design'])
    const draft = await must<any>(
      await newReport(designer.http, 'sales_documents', detail(['number']), {
        visibility: 'TENANT',
      }),
      201
    )
    assert.equal(draft.status, 'DRAFT')
    assert.equal((await reader.http.get(`/api/v1/reports/${draft.id}`)).status(), 404)
    assert.equal((await run(reader.http, draft.id)).status(), 404)
    assert.equal((await run(designer.http, draft.id)).status(), 200)
    // Só o dono altera.
    assert.equal(
      (
        await a.http.patch(`/api/v1/reports/${draft.id}`, {
          version: 1,
          name: 'x',
          datasetCode: 'sales_documents',
          query: detail(['number']),
        })
      ).status(),
      404
    )
    const edited = await must<any>(
      await designer.http.patch(`/api/v1/reports/${draft.id}`, {
        version: draft.version,
        name: 'Renomeado',
        datasetCode: 'sales_documents',
        visibility: 'TENANT',
        query: detail(['number', 'amount']),
      }),
      200
    )
    assert.equal(edited.name, 'Renomeado')
    const stale = await designer.http.patch(`/api/v1/reports/${draft.id}`, {
      version: draft.version,
      name: 'x',
      datasetCode: 'sales_documents',
      query: detail(['number']),
    })
    assert.equal(stale.status(), 409)
    await must(await designer.http.post(`/api/v1/reports/${draft.id}/publish`, {}), 200)
    assert.equal((await reader.http.get(`/api/v1/reports/${draft.id}`)).status(), 200)
    assert.equal((await run(reader.http, draft.id)).status(), 200)
    const frozen = await designer.http.patch(`/api/v1/reports/${draft.id}`, {
      version: 99,
      name: 'x',
      datasetCode: 'sales_documents',
      query: detail(['number']),
    })
    assert.equal(code(frozen), 'REPORT_PUBLISHED_IMMUTABLE')
    assert.equal(
      code(await designer.http.delete(`/api/v1/reports/${draft.id}`)),
      'REPORT_PUBLISHED_IMMUTABLE'
    )
    await assert.rejects(
      () => owner(`update report_definitions set name = 'adulterado' where id = '${draft.id}'`, a),
      /REPORT_PUBLISHED_IMMUTABLE/
    )
    // Quem só lê não desenha nem publica.
    assert.equal(
      (
        await reader.http.post('/api/v1/reports', {
          code: 'x_y',
          name: 'x',
          datasetCode: 'sales_documents',
          query: detail(['number']),
        })
      ).status(),
      403
    )
    const copy = await must<any>(
      await designer.http.post(`/api/v1/reports/${draft.id}/duplicate`, { code: `copia_${seq++}` }),
      201
    )
    assert.deepInclude(copy, { status: 'DRAFT', visibility: 'PRIVATE' })
    assert.equal((await designer.http.delete(`/api/v1/reports/${copy.id}`)).status(), 204)
    const dup = await newReport(designer.http, 'sales_documents', detail(['number']), {
      code: draft.code,
    })
    assert.equal(code(dup), 'REPORT_CODE_TAKEN')
    // Um privado publicado não se vê.
    const priv = await publishedReport(
      designer.http,
      'sales_documents',
      detail(['number']),
      'PRIVATE'
    )
    assert.equal((await reader.http.get(`/api/v1/reports/${priv}`)).status(), 404)
    const list = await must<any[]>(await reader.http.get('/api/v1/reports'), 200)
    assert.isFalse(list.some((r) => r.id === priv))
  })

  test('painel: widgets só de relatórios publicados e partilhados; filtros globais com drill-down; falha isolada', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const designer = await memberWith(client, a, [...READER, 'report.design'])
    const viewer = await memberWith(client, a, ['report.read', 'invoice.read'])
    const kpi = await publishedReport(designer.http, 'sales_documents', {
      groupBy: ['currency'],
      measures: [{ fn: 'sum', field: 'amount', alias: 'total' }],
    })
    const orders = await publishedReport(designer.http, 'sales_orders', {
      measures: [{ fn: 'count', alias: 'n' }],
    })
    const draft = await must<any>(
      await newReport(designer.http, 'sales_documents', detail(['number']), {
        visibility: 'TENANT',
      }),
      201
    )
    const priv = await publishedReport(
      designer.http,
      'sales_documents',
      detail(['number']),
      'PRIVATE'
    )
    const dash = await must<any>(
      await designer.http.post('/api/v1/dashboards', {
        name: 'Painel de teste',
        visibility: 'TENANT',
      }),
      201
    )
    const add = (body: Record<string, unknown>) =>
      designer.http.post(`/api/v1/dashboards/${dash.id}/widgets`, {
        title: 'W',
        type: 'KPI',
        ...body,
      })
    assert.equal(code(await add({ reportId: draft.id })), 'REPORT_NOT_PUBLISHED')
    assert.equal(code(await add({ reportId: priv })), 'REPORT_NOT_SHARED')
    assert.equal(code(await add({ reportId: kpi, refreshSeconds: 10 })), 'INVALID')
    assert.equal(code(await add({ reportId: kpi, type: 'RADAR' })), 'INVALID')
    const w1 = await must<any>(
      await add({ reportId: kpi, title: 'Vendas', refreshSeconds: 60 }),
      201
    )
    const w2 = await must<any>(
      await add({ reportId: orders, title: 'Encomendas', type: 'KPI' }),
      201
    )
    const data = await must<any>(await viewer.http.get(`/api/v1/dashboards/${dash.id}/data`), 200)
    assert.lengthOf(data.widgets, 2)
    assert.property(data, 'asOf')
    const sales = data.widgets.find((w: any) => w.widgetId === w1.id)
    const direct = await must<any>(await run(viewer.http, kpi), 200)
    assert.deepEqual(sales.result.rows, direct.rows)
    assert.deepEqual(sales.drill, { reportId: kpi, filters: [] })
    // O leitor não tem order.read: esse widget falha sozinho e o painel carrega.
    const failing = data.widgets.find((w: any) => w.widgetId === w2.id)
    assert.isNull(failing.result)
    assert.equal(failing.error.code, 'PERMISSION_DENIED')
    // Filtro global: aplica-se onde o dataset tem o campo, e diz onde não aplicou.
    const globals = JSON.stringify([
      { field: 'currency', op: 'eq', value: 'ZZZ' },
      { field: 'campo_inexistente', op: 'eq', value: 'x' },
    ])
    const filtered = await must<any>(
      await designer.http.get(
        `/api/v1/dashboards/${dash.id}/data?filters=${encodeURIComponent(globals)}`
      ),
      200
    )
    const fSales = filtered.widgets.find((w: any) => w.widgetId === w1.id)
    assert.lengthOf(fSales.result.rows, 0)
    assert.deepEqual(
      fSales.ignoredFilters.map((f: any) => f.field),
      ['campo_inexistente']
    )
    assert.deepEqual(
      fSales.drill.filters.map((f: any) => f.field),
      ['currency']
    )
    // O drill-down corre o mesmo relatório com os mesmos filtros.
    const drilled = await must<any>(
      await run(designer.http, kpi, { filters: fSales.drill.filters }),
      200
    )
    assert.deepEqual(drilled.rows, fSales.result.rows)
    assert.equal(
      (await viewer.http.get(`/api/v1/dashboards/${dash.id}/data?filters=nao-json`)).status(),
      400
    )
    // Edição: versão, remoção e permissões.
    assert.equal((await viewer.http.post('/api/v1/dashboards', { name: 'x' })).status(), 403)
    const patched = await must<any>(
      await designer.http.patch(`/api/v1/dashboards/${dash.id}/widgets/${w1.id}`, {
        version: w1.version,
        title: 'Vendas (v2)',
        type: 'BAR',
        reportId: kpi,
      }),
      200
    )
    assert.equal(patched.type, 'BAR')
    assert.equal(
      (
        await designer.http.patch(`/api/v1/dashboards/${dash.id}/widgets/${w1.id}`, {
          version: w1.version,
          title: 'x',
          type: 'BAR',
          reportId: kpi,
        })
      ).status(),
      409
    )
    assert.equal(
      (await designer.http.delete(`/api/v1/dashboards/${dash.id}/widgets/${w2.id}`)).status(),
      204
    )
    assert.equal(
      code(await designer.http.delete(`/api/v1/reports/${kpi}`)),
      'REPORT_PUBLISHED_IMMUTABLE'
    )
    // Um painel privado de outro não se vê.
    const mine = await must<any>(
      await designer.http.post('/api/v1/dashboards', { name: 'Privado' }),
      201
    )
    assert.equal((await viewer.http.get(`/api/v1/dashboards/${mine.id}`)).status(), 404)
    assert.equal((await designer.http.delete(`/api/v1/dashboards/${dash.id}`)).status(), 204)
  })
})

test.group('relatórios | exportações assíncronas', (group) => {
  group.each.timeout(240_000)

  const work = async (world: World) => {
    const { exports, resolver } = reportingServices()
    let done = 0
    while (await exports.processNext(world.tenant.id, resolver)) done += 1
    return done
  }
  const csv = (buffer: Buffer) =>
    buffer.toString('utf8').replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '')

  test('pedir não executa: fica em fila; o trabalhador gera o CSV com BOM e só as colunas visíveis', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const exporter = await memberWith(client, a, [
      'report.read',
      'report.export',
      'report.design',
      'order.read',
    ])
    const id = await publishedReport(
      a.http,
      'sales_orders',
      detail(['number', 'status', 'total', 'credit_reservation'])
    )
    const job = await must<any>(await exporter.http.post('/api/v1/exports', { reportId: id }), 202)
    assert.equal(job.status, 'QUEUED')
    assert.equal((await exporter.http.getRaw(`/api/v1/exports/${job.id}/download`)).status, 409)
    assert.isAtLeast(await work(a), 1)
    const ready = await must<any>(await exporter.http.get(`/api/v1/exports/${job.id}`), 200)
    assert.equal(ready.status, 'READY')
    assert.isAbove(ready.rowCount, 0)
    assert.deepEqual(ready.columns, ['number', 'status', 'total'])
    assert.isOk(ready.expiresAt)
    const file = await exporter.http.getRaw(`/api/v1/exports/${job.id}/download`)
    assert.equal(file.status, 200)
    assert.include(file.headers.get('content-disposition') ?? '', 'attachment;')
    assert.equal(file.headers.get('content-type'), 'text/csv')
    assert.isTrue(file.buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    const lines = csv(file.buffer).trimEnd().split('\r\n')
    assert.equal(lines[0], 'Número,Estado,Total')
    assert.lengthOf(lines, ready.rowCount + 1)
    assert.notInclude(csv(file.buffer), 'Crédito reservado')
    // O administrador, com o campo sensível, tem-no na sua própria exportação.
    const adminJob = await must<any>(await a.http.post('/api/v1/exports', { reportId: id }), 202)
    await work(a)
    const adminFile = await a.http.getRaw(`/api/v1/exports/${adminJob.id}/download`)
    assert.include(csv(adminFile.buffer).split('\r\n')[0], 'Crédito reservado')
    // Cada pessoa só vê as suas exportações.
    assert.equal((await exporter.http.get(`/api/v1/exports/${adminJob.id}`)).status(), 404)
    assert.equal(
      (await exporter.http.getRaw(`/api/v1/exports/${adminJob.id}/download`)).status,
      404
    )
    const mine = await must<any[]>(await exporter.http.get('/api/v1/exports'), 200)
    assert.deepEqual(
      mine.map((j) => j.id),
      [job.id]
    )
  })

  test('formato por suportar, relatório em rascunho e filtros inválidos falham ao pedir', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const id = await publishedReport(a.http, 'sales_documents', detail(['number']))
    assert.equal(
      code(await a.http.post('/api/v1/exports', { reportId: id, format: 'XLSX' })),
      'FORMAT_NOT_SUPPORTED'
    )
    assert.equal(
      code(await a.http.post('/api/v1/exports', { reportId: id, format: 'PDF' })),
      'FORMAT_NOT_SUPPORTED'
    )
    const draft = await must<any>(
      await newReport(a.http, 'sales_documents', detail(['number'])),
      201
    )
    assert.equal(
      code(await a.http.post('/api/v1/exports', { reportId: draft.id })),
      'REPORT_NOT_PUBLISHED'
    )
    assert.equal(
      (
        await a.http.post('/api/v1/exports', {
          reportId: id,
          filters: [{ field: 'total', op: 'eq', value: 'x' }],
        })
      ).status(),
      422
    )
    const reader = await memberWith(client, a, ['report.read', 'invoice.read'])
    assert.equal((await reader.http.post('/api/v1/exports', { reportId: id })).status(), 403)
  })

  test('o CSV neutraliza células que seriam fórmulas', async ({ client, assert }) => {
    const { a } = await worlds(client)
    const account = { id: a.ids.bankAccount }
    const payer = a.ids.organizationParty
    const org = a.ids.organization
    const payment = await must<{ id: string }>(
      await a.http.post('/api/v1/payments', {
        organizationId: org,
        direction: 'INBOUND',
        partyId: payer,
        treasuryAccountId: account.id,
        amount: '0.0100',
        reference: '=HYPERLINK("http://mal.invalid","clique")',
        allocations: [{ receivableId: a.ids.receivable, amount: '0.0100' }],
      }),
      201
    )
    await must(await a.http.post(`/api/v1/payments/${payment.id}/confirm`, {}), 200)
    const report = await publishedReport(
      a.http,
      'payments_received',
      detail(['amount', 'reference'])
    )
    const job = await must<any>(await a.http.post('/api/v1/exports', { reportId: report }), 202)
    await work(a)
    const file = await a.http.getRaw(`/api/v1/exports/${job.id}/download`)
    const text = csv(file.buffer)
    assert.include(text, `"'=HYPERLINK(""http://mal.invalid"",""clique"")"`)
    assert.notMatch(text, /(^|,)=HYPERLINK/m)
  })

  test('revogar o acesso invalida a exportação: antes de executar, e o descarregamento pendente', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const id = await publishedReport(a.http, 'sales_documents', detail(['number', 'amount']))
    // 1) Revogado antes de o trabalhador executar: o trabalho falha e não gera ficheiro.
    const early = await memberWith(client, a, ['report.read', 'report.export', 'invoice.read'])
    const queued = await must<any>(await early.http.post('/api/v1/exports', { reportId: id }), 202)
    assert.equal(
      (await a.http.delete(`/api/v1/role-assignments/${early.assignmentId}`)).status(),
      204
    )
    await work(a)
    const failed = await owner<any>(
      `select status, error_code, attachment_id from export_jobs where id = '${queued.id}'`,
      a
    )
    assert.equal(failed[0].status, 'FAILED')
    assert.equal(failed[0].error_code, 'ACCESS_REVOKED')
    assert.isNull(failed[0].attachment_id)

    // 2) Pronta, mas o dataset deixa de ser legível para quem pediu: o descarregamento pendente recusa.
    const later = await memberWith(client, a, ['report.read', 'report.export', 'invoice.read'])
    const job = await must<any>(await later.http.post('/api/v1/exports', { reportId: id }), 202)
    await work(a)
    assert.equal((await later.http.getRaw(`/api/v1/exports/${job.id}/download`)).status, 200)
    assert.equal(
      (await a.http.delete(`/api/v1/role-assignments/${later.assignmentId}`)).status(),
      204
    )
    const without = await must<{ id: string }>(
      await a.http.post('/api/v1/roles', {
        code: `r_${seq++}`,
        name: 'Sem facturas',
        permissionCodes: ['report.read', 'report.export'],
      }),
      201
    )
    await must(
      await a.http.post('/api/v1/role-assignments', {
        membershipId: later.actor.membershipId,
        roleId: without.id,
      }),
      201
    )
    const denied = await later.http.getRaw(`/api/v1/exports/${job.id}/download`)
    assert.equal(denied.status, 403)
    assert.equal(denied.json().error.code, 'EXPORT_ACCESS_REVOKED')
    // Sem o direito de exportar, o descarregamento nem chega ao serviço.
    assert.equal(
      (
        await a.http.delete(
          `/api/v1/role-assignments/${(await must<any[]>(await a.http.get(`/api/v1/role-assignments?membershipId=${later.actor.membershipId}`), 200))[0]?.id}`
        )
      ).status() >= 200,
      true
    )
    assert.include(
      [403, 404],
      (await later.http.getRaw(`/api/v1/exports/${job.id}/download`)).status
    )
  })

  test('o descarregamento volta a validar o dataset e os campos do ficheiro', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const id = await publishedReport(
      a.http,
      'sales_orders',
      detail(['number', 'credit_reservation'])
    )
    const exporter = await memberWith(client, a, [
      'report.read',
      'report.export',
      'order.read',
      'customer.credit_manage',
    ])
    const job = await must<any>(await exporter.http.post('/api/v1/exports', { reportId: id }), 202)
    await work(a)
    assert.include(
      csv((await exporter.http.getRaw(`/api/v1/exports/${job.id}/download`)).buffer),
      'Crédito reservado'
    )
    // A permissão do campo sensível é retirada: o ficheiro, que a leva, já não se entrega.
    await a.http.delete(`/api/v1/role-assignments/${exporter.assignmentId}`)
    const stripped = await must<{ id: string }>(
      await a.http.post('/api/v1/roles', {
        code: `r_${seq++}`,
        name: 'Sem crédito',
        permissionCodes: ['report.read', 'report.export', 'order.read'],
      }),
      201
    )
    await must(
      await a.http.post('/api/v1/role-assignments', {
        membershipId: exporter.actor.membershipId,
        roleId: stripped.id,
      }),
      201
    )
    const denied = await exporter.http.getRaw(`/api/v1/exports/${job.id}/download`)
    assert.equal(denied.status, 403)
    assert.equal(denied.json().error.code, 'EXPORT_ACCESS_REVOKED')
  })

  test('uma exportação expira: o descarregamento recusa e o ficheiro sai do armazenamento', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const id = await publishedReport(a.http, 'sales_documents', detail(['number']))
    const job = await must<any>(await a.http.post('/api/v1/exports', { reportId: id }), 202)
    await work(a)
    const before = await owner<any>(
      `select attachment_id from export_jobs where id = '${job.id}'`,
      a
    )
    await owner(
      `update export_jobs set expires_at = now() - interval '1 minute' where id = '${job.id}'`,
      a
    )
    const expired = await a.http.getRaw(`/api/v1/exports/${job.id}/download`)
    assert.equal(expired.status, 409)
    assert.equal(expired.json().error.code, 'EXPORT_EXPIRED')
    assert.equal(
      (await must<any>(await a.http.get(`/api/v1/exports/${job.id}`), 200)).status,
      'EXPIRED'
    )
    const att = await owner<any>(
      `select status from attachments where id = '${before[0].attachment_id}'`,
      a
    )
    assert.equal(att[0].status, 'DELETED')
    // O ficheiro gerado também não é descarregável pelos documentos.
    assert.equal(
      (await a.http.getRaw(`/api/v1/attachments/${before[0].attachment_id}/download`)).status,
      404
    )
    // Varrimento: marca como expirados os prontos fora de prazo.
    const second = await must<any>(await a.http.post('/api/v1/exports', { reportId: id }), 202)
    await work(a)
    await owner(
      `update export_jobs set expires_at = now() - interval '1 minute' where id = '${second.id}'`,
      a
    )
    const { exports, resolver } = reportingServices()
    assert.isAtLeast((await exports.sweep(a.tenant.id, resolver)).expired, 1)
    assert.equal(
      (await must<any>(await a.http.get(`/api/v1/exports/${second.id}`), 200)).status,
      'EXPIRED'
    )
  })

  test('trabalhos que ficaram a correr de um processo caído voltam à fila', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const id = await publishedReport(a.http, 'sales_documents', detail(['number']))
    const job = await must<any>(await a.http.post('/api/v1/exports', { reportId: id }), 202)
    await owner(
      `update export_jobs set status = 'RUNNING', started_at = now() - interval '1 hour' where id = '${job.id}'`,
      a
    )
    const { exports, resolver } = reportingServices()
    assert.equal((await exports.sweep(a.tenant.id, resolver)).requeued, 1)
    await work(a)
    assert.equal(
      (await must<any>(await a.http.get(`/api/v1/exports/${job.id}`), 200)).status,
      'READY'
    )
  })

  test('dois trabalhadores nunca tratam o mesmo trabalho', async ({ client, assert }) => {
    const { a } = await worlds(client)
    const id = await publishedReport(a.http, 'sales_documents', detail(['number']))
    const jobs = await Promise.all(
      Array.from({ length: 3 }, () => a.http.post('/api/v1/exports', { reportId: id }))
    )
    const ids = jobs.map((j) => j.body().data.id)
    const { exports, resolver } = reportingServices()
    const results = await Promise.all(
      Array.from({ length: 6 }, () => exports.processNext(a.tenant.id, resolver))
    )
    assert.isAtLeast(results.filter(Boolean).length, 3)
    for (const jobId of ids) {
      assert.equal(
        (await must<any>(await a.http.get(`/api/v1/exports/${jobId}`), 200)).status,
        'READY'
      )
    }
    const attachments = await owner<any>(
      `select count(distinct attachment_id)::int as n from export_jobs where id in ('${ids.join("','")}')`,
      a
    )
    assert.equal(attachments[0].n, 3)
    assert.isOk(documentServices())
  })
})

test.group('pesquisa | índice derivado, autorização e frescura', (group) => {
  group.each.timeout(240_000)
  group.teardown(async () => {
    await deleteTestTenants()
    await deleteTestUsers()
  })

  test('reindexar é idempotente; a pesquisa agrupa por tipo e devolve excertos', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const first = await must<any[]>(await a.http.post('/api/v1/search/reindex', {}), 200)
    const second = await must<any[]>(await a.http.post('/api/v1/search/reindex', {}), 200)
    assert.deepEqual(
      first.map((r) => [r.type, r.indexed]),
      second.map((r) => [r.type, r.indexed])
    )
    assert.isTrue(second.every((r) => r.removed === 0))
    const counts = await owner<any>(
      `select resource_type, count(*)::int as n from search_documents group by 1 order by 1`,
      a
    )
    const status = await must<any[]>(await a.http.get('/api/v1/search/status'), 200)
    for (const row of counts)
      assert.equal(status.find((s) => s.type === row.resource_type).documents, row.n)
    assert.isTrue(status.every((s) => s.indexedAt))
    const duplicates = await owner<any>(
      `select resource_type, resource_id from search_documents group by 1, 2 having count(*) > 1`,
      a
    )
    assert.lengthOf(duplicates, 0)

    const customer = (await must<any[]>(await a.http.get('/api/v1/customers?limit=5'), 200))[0]
    const found = await must<any>(
      await a.http.get(`/api/v1/search?q=${encodeURIComponent(customer.code)}`),
      200
    )
    const hit = found.groups.find((g: any) => g.type === 'customer')
    assert.isOk(hit)
    assert.equal(hit.label, 'Clientes')
    assert.include(
      hit.items.map((i: any) => i.id),
      customer.id
    )
    assert.include(hit.items[0].snippet, customer.code)
    assert.isOk(found.indexedAt)
    const invoice = await must<any>(await a.http.get('/api/v1/search?q=Factura'), 200)
    assert.isTrue(invoice.groups.some((g: any) => g.type === 'invoice'))
  })

  test('a autorização vem antes dos excertos: tipo sem permissão e documento privado de outro não aparecem', async ({
    client,
    assert,
  }) => {
    const { a } = await worlds(client)
    const customer = (await must<any[]>(await a.http.get('/api/v1/customers?limit=5'), 200))[0]
    const onlyDocs = await memberWith(client, a, ['search.read', 'document.read'])
    const res = await must<any>(
      await onlyDocs.http.get(`/api/v1/search?q=${encodeURIComponent(customer.code)}`),
      200
    )
    assert.deepEqual(res.groups, [])
    // Documento privado da administração: está no índice, mas outra pessoa não o recebe.
    const bytes = Buffer.from('conteúdo secreto xyzzy')
    const prepared = await must<any>(
      await a.http.post('/api/v1/attachments/prepare', {
        fileName: 'segredo-xyzzy.txt',
        mimeType: 'text/plain',
        sizeBytes: bytes.length,
        checksum: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),
      }),
      201
    )
    await a.http.putRaw(prepared.uploadPath, bytes)
    await must(await a.http.post(`/api/v1/attachments/${prepared.id}/complete`, {}), 200)
    const doc = await must<any>(
      await a.http.post('/api/v1/documents', {
        title: 'Plano xyzzy confidencial',
        attachmentId: prepared.id,
        visibility: 'PRIVATE',
      }),
      201
    )
    await a.http.post('/api/v1/search/reindex', {})
    const indexed = await owner<any>(
      `select count(*)::int as n from search_documents where resource_id = '${doc.id}'`,
      a
    )
    assert.equal(indexed[0].n, 1)
    const reader = await memberWith(client, a, ['search.read', 'document.read'])
    const hidden = await must<any>(await reader.http.get('/api/v1/search?q=xyzzy'), 200)
    assert.deepEqual(hidden.groups, [])
    assert.notInclude(JSON.stringify(hidden), 'confidencial')
    const mine = await must<any>(await a.http.get('/api/v1/search?q=xyzzy'), 200)
    assert.include(
      mine.groups.find((g: any) => g.type === 'document').items.map((i: any) => i.id),
      doc.id
    )
    // Sem search.read nem entra; termo curto é recusado.
    assert.equal(
      (await api(client, a.tenant, a.operator).get('/api/v1/search?q=abc')).status(),
      403
    )
    assert.equal((await a.http.get('/api/v1/search?q=a')).status(), 422)
    // Apagar o documento: sai dos resultados mesmo antes de reindexar (a revalidação recusa) e do índice depois.
    assert.equal((await a.http.delete(`/api/v1/documents/${doc.id}`)).status(), 204)
    const gone = await must<any>(await a.http.get('/api/v1/search?q=xyzzy'), 200)
    assert.deepEqual(gone.groups, [])
    const removed = await must<any[]>(await a.http.post('/api/v1/search/reindex', {}), 200)
    assert.isAtLeast(removed.find((r) => r.type === 'document').removed, 1)
    assert.equal(
      (
        await owner<any>(
          `select count(*)::int as n from search_documents where resource_id = '${doc.id}'`,
          a
        )
      )[0].n,
      0
    )
  })

  test('o índice e os resultados são de cada tenant', async ({ client, assert }) => {
    const { a, b } = await worlds(client)
    await a.http.post('/api/v1/search/reindex', {})
    await b.http.post('/api/v1/search/reindex', {})
    const idsA = (await owner<any>(`select resource_id from search_documents`, a)).map(
      (r) => r.resource_id
    )
    const idsB = (await owner<any>(`select resource_id from search_documents`, b)).map(
      (r) => r.resource_id
    )
    assert.isEmpty(idsA.filter((id) => idsB.includes(id)))
    const customerB = (await must<any[]>(await b.http.get('/api/v1/customers?limit=5'), 200))[0]
    const fromA = await must<any>(await a.http.get('/api/v1/search?q=Comum'), 200)
    for (const g of fromA.groups) for (const item of g.items) assert.notInclude(idsB, item.id)
    assert.isOk(customerB)
  })
})
