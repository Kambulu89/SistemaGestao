import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  signIn,
  tenantWithAdmin,
  type Session,
} from '#tests/support/fixtures'

const S = '/api/v1/sales'
const C = `${S}/collections`
const owner = () => db.connection('owner')
const ok = (r: any, status = 200) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const paths = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.path)
const day = (n: number) => {
  const x = new Date()
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}
// Valores fiscais ilustrativos de teste, não taxas legais.
const SOURCE = 'Fonte de teste — não é diploma real'

async function member(client: any, admin: Session, roleCode: string, permissions: string[]) {
  const m = await memberWithRoles(client, admin, [])
  const role = await createRole(client, admin, roleCode, permissions)
  ok(
    await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
      roleId: role.id,
      scopeType: 'TENANT',
    })
  )
  return as(client, m.session)
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post('/api/v1/organization/legal-entities', {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000931',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    }),
    201
  )
  const collector = await member(client, s, 'cobrador', ['sales.collections.manage'])
  const reader = await member(client, s, 'leitor_cob', ['sales.collections.read'])
  const outsider = await member(client, s, 'outro', ['sales.invoices.read'])
  const clerk = await member(client, s, 'cobranca', ['sales.receipts.manage'])
  const treasurer = await member(client, s, 'tesouraria', ['sales.receipts.confirm'])
  const confirmer = await member(client, s, 'fiscal_conf', ['sales.fiscal.confirm'])
  const uom = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    }),
    201
  )
  const sv = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'INST',
      name: 'Instalação',
      productType: 'SERVICE',
      baseUomId: uom.id,
      currency: 'AOA',
      salePrice: '500',
    }),
    201
  )
  const c1 = ok(
    await api.post(`${S}/customers`, {
      currency: 'AOA',
      paymentTermsDays: 30,
      creditLimit: '2000',
      partner: {
        code: 'CLI-1',
        name: 'Cliente Um',
        partnerType: 'ORGANIZATION',
        taxId: '5417000071',
        countryCode: 'AO',
      },
    }),
    201
  )
  // Imposto a 10 % desde dois anos atrás; séries de facturas para o ano passado e este (as datas recuam ~100 dias).
  const year = Number(day(0).slice(0, 4))
  let t10 = ok(
    await api.post(`${S}/fiscal/tax-codes`, {
      countryCode: 'AO',
      code: 'T10',
      name: 'Imposto de teste',
      kind: 'TAX',
      taxType: 'VAT',
    }),
    201
  )
  t10 = ok(
    await api.post(`${S}/fiscal/tax-codes/${t10.id}/rates`, {
      rate: '10',
      validFrom: `${year - 2}-01-01`,
      legalSource: SOURCE,
    }),
    201
  )
  ok(
    await confirmer.post(`${S}/fiscal/tax-rates/${t10.rates[0].id}/confirm`, {
      expectedVersion: t10.rates[0].version,
    })
  )
  for (const [kind, c] of [
    ['INVOICE', 'FT'],
    ['RECEIPT', 'RC'],
  ])
    for (const y of [year - 1, year]) {
      const x = ok(
        await api.post(`${S}/fiscal/series`, {
          legalEntityId: le.id,
          documentKind: kind,
          fiscalCode: c,
          code: `${c}${y}`,
          fiscalYear: y,
          prefix: `${c} ${y}/`,
        }),
        201
      )
      ok(await api.post(`${S}/fiscal/series/${x.id}/activate`, { expectedVersion: x.version }))
    }
  ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'SALES_ORDER',
      code: 'EV',
      prefix: 'EV-',
    }),
    201
  )
  // Facturas de 550,00 (500 + 10 %) a 30 dias: emitidas há 100 dias (61–90), há 40 (1–30) e hoje (por vencer).
  const invoice = async (date: string) => {
    let i = ok(
      await api.post(`${S}/invoices`, {
        legalEntityId: le.id,
        customerId: c1.id,
        invoiceDate: date,
        lines: [{ productId: sv.id, quantity: '1', taxCodeIds: [t10.id] }],
      }),
      201
    )
    i = ok(await api.post(`${S}/invoices/${i.id}/issue`, { expectedVersion: i.version }))
    return i
  }
  const old = await invoice(day(-100))
  const late = await invoice(day(-40))
  const fresh = await invoice(day(0))
  const pay = async (key: string, amount: string, allocations: any[]) => {
    const r = ok(
      await clerk.post(`${S}/receipts`, {
        requestKey: key,
        legalEntityId: le.id,
        customerId: c1.id,
        amount,
        method: 'CASH',
        receivedDate: day(0),
        allocations,
      }),
      201
    )
    return ok(
      await treasurer.post(`${S}/receipts/${r.id}/confirm`, {
        expectedVersion: r.version,
        seriesId: null,
      })
    )
  }
  return {
    tenant,
    api,
    le,
    sv,
    c1,
    collector,
    reader,
    outsider,
    old,
    late,
    fresh,
    pay,
  }
}

test.group('Vendas | cobranças (10.10)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('contas a receber: antiguidade, adiantamentos, limite de crédito com exposição e encomendas', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    assert.equal((await o.outsider.get(C)).status(), 403)
    let list = ok(await o.reader.get(C))
    assert.equal(list.length, 1)
    assert.deepEqual(
      [list[0].open, list[0].overdue, list[0].aging, list[0].invoices, list[0].creditLimit],
      [
        '1650.00',
        '1100.00',
        { CURRENT: '550.00', D1_30: '550.00', D31_60: '0.00', D61_90: '550.00', D90_PLUS: '0.00' },
        3,
        '2000.00',
      ]
    )
    // Recebimento de 700 confirmado: 550 na mais antiga e 150 de adiantamento.
    const rc = await o.pay('rec-000001', '700', [{ invoiceId: o.old.id, amount: '550' }])
    assert.equal(rc.advanceRemaining, '150.00')
    const st = ok(await o.reader.get(`${C}/${o.c1.id}`))
    assert.deepEqual(
      [
        st.receivables.summary[0].open,
        st.receivables.summary[0].overdue,
        st.receivables.summary[0].advances,
      ],
      ['1100.00', '550.00', '150.00']
    )
    assert.equal(st.receivables.summary[0].net, '950.00')
    assert.deepEqual(
      st.receivables.invoices.map((i: any) => [i.number, i.bucket, i.open]),
      [
        [o.late.number, 'D1_30', '550.00'],
        [o.fresh.number, 'CURRENT', '550.00'],
      ]
    )
    assert.equal(st.receivables.invoices[0].daysOverdue, 10)
    assert.deepEqual(
      [
        st.credit.limit,
        st.credit.receivables,
        st.credit.openOrders,
        st.credit.exposure,
        st.credit.available,
      ],
      ['2000.00', '950.00', '0.00', '950.00', '1050.00']
    )
    // O limite de crédito da encomenda passa a contar as contas a receber: 950 + 1 100 > 2 000 → aprovação.
    let so = ok(
      await o.api.post(`${S}/orders`, {
        legalEntityId: o.le.id,
        customerId: o.c1.id,
        orderDate: day(0),
        lines: [{ productId: o.sv.id, quantity: '2', taxRate: '10' }],
      }),
      201
    )
    so = ok(await o.api.post(`${S}/orders/${so.id}/submit`, { expectedVersion: so.version }))
    assert.deepEqual(
      [
        so.approvalStatus,
        so.creditCheck.receivables,
        so.creditCheck.exposure,
        so.creditCheck.exceeded,
      ],
      ['PENDING', '950.00', '2050.00', true]
    )
    // Só vencidas.
    list = ok(await o.reader.get(`${C}?overdue=true`))
    assert.equal(list[0].overdue, '550.00')
  })

  test('promessa de pagamento não é pagamento; cumprida, falhada e anulada; contactos de cobrança', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const P = `${C}/${o.c1.id}/promises`
    const body = {
      legalEntityId: o.le.id,
      amount: '550',
      promisedDate: day(5),
      invoiceIds: [o.late.id],
      contactName: 'Sr. Silva',
    }
    assert.equal((await o.reader.post(P, body)).status(), 403)
    assert.include(
      paths(await o.collector.post(P, { ...body, promisedDate: day(-1) })),
      'promisedDate'
    )
    assert.equal(code(await o.collector.post(P, { ...body, amount: '600' })), 'OVER_PROMISE')
    const p1 = ok(await o.collector.post(P, body), 201)
    assert.deepEqual([p1.status, p1.paidSince], ['OPEN', '0.00'])
    // Promessa ≠ pagamento: os saldos não mudam.
    let st = ok(await o.reader.get(`${C}/${o.c1.id}`))
    assert.equal(st.receivables.summary[0].open, '1650.00')
    assert.equal(ok(await o.api.get(`${S}/invoices/${o.late.id}`)).paidTotal, '0.00')
    // Pagamento confirmado da factura prometida: cumprida.
    await o.pay('rec-000002', '550', [{ invoiceId: o.late.id, amount: '550' }])
    st = ok(await o.reader.get(`${C}/${o.c1.id}`))
    assert.deepEqual([st.promises[0].status, st.promises[0].paidSince], ['KEPT', '550.00'])
    // Promessa já vencida sem pagamento: falhada (inserida com a data passada).
    const broken = (
      await owner().rawQuery(
        `insert into collection_promises (tenant_id, legal_entity_id, customer_id, currency, amount, promised_date, invoice_ids)
         values (?, ?, ?, 'AOA', 550, ?, ARRAY[?]::uuid[]) returning id, version`,
        [o.tenant.id, o.le.id, o.c1.id, day(-2), o.old.id]
      )
    ).rows[0]
    st = ok(await o.reader.get(`${C}/${o.c1.id}`))
    assert.equal(st.promises.find((p: any) => p.id === broken.id).status, 'BROKEN')
    assert.equal(
      code(
        await o.collector.post(`${S}/collection-promises/${broken.id}/cancel`, {
          expectedVersion: broken.version,
          reason: 'Teste',
        })
      ),
      'INVALID_STATE'
    )
    const list = ok(await o.reader.get(C))
    assert.equal(list[0].brokenPromises, 1)
    // Anular uma promessa em aberto, com motivo.
    const p2 = ok(await o.collector.post(P, { ...body, invoiceIds: [o.fresh.id] }), 201)
    assert.include(
      paths(
        await o.collector.post(`${S}/collection-promises/${p2.id}/cancel`, {
          expectedVersion: p2.version,
        })
      ),
      'reason'
    )
    const cancelled = ok(
      await o.collector.post(`${S}/collection-promises/${p2.id}/cancel`, {
        expectedVersion: p2.version,
        reason: 'Cliente pediu outra data',
      })
    )
    assert.equal(cancelled.status, 'CANCELLED')
    // Contactos: com próxima acção, ligados à promessa; data passada recusada.
    const A = `${C}/${o.c1.id}/activities`
    const act = {
      legalEntityId: o.le.id,
      kind: 'CALL',
      outcome: 'PROMISED',
      contactName: 'Sr. Silva',
      notes: 'Prometeu pagar a factura antiga',
      nextActionDate: day(3),
      promiseId: p1.id,
    }
    assert.include(
      paths(await o.collector.post(A, { ...act, nextActionDate: day(-1) })),
      'nextActionDate'
    )
    assert.equal((await o.reader.post(A, act)).status(), 403)
    ok(await o.collector.post(A, act), 201)
    const w = ok(await o.reader.get(C))
    assert.deepEqual(
      [w[0].lastActivity.kind, w[0].lastActivity.outcome, w[0].nextActionDate],
      ['CALL', 'PROMISED', day(3)]
    )
    st = ok(await o.reader.get(`${C}/${o.c1.id}`))
    assert.deepEqual(
      [st.activities.length, st.activities[0].promiseId, st.activities[0].contactName],
      [1, p1.id, 'Sr. Silva']
    )
    // Base: a promessa não muda (só anular) e os contactos são só de acréscimo.
    for (const sql of [
      `update collection_promises set amount = 1 where id = '${p1.id}'`,
      `update collection_promises set promised_date = '2000-01-01' where id = '${p1.id}'`,
      `update collection_promises set cancel_reason = 'x' where id = '${p2.id}'`,
      `delete from collection_promises where id = '${p1.id}'`,
      `update collection_activities set notes = 'x'`,
      `delete from collection_activities`,
    ])
      await assert.rejects(() => owner().rawQuery(sql))
    const audits = await owner().rawQuery(
      `select action from audit_events where tenant_id = ? and action like 'collection.%' order by created_at`,
      [o.tenant.id]
    )
    assert.includeMembers(
      audits.rows.map((x: any) => x.action),
      ['collection.promise_created', 'collection.promise_cancelled', 'collection.activity_logged']
    )
  })
})
