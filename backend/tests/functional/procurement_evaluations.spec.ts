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

const P = '/api/v1/procurement'
const EV = `${P}/evaluations`
const O = `${P}/orders`
const R = `${P}/receipts`
const F = `${P}/invoices`
const Q = `${P}/rfqs`
const ORG = '/api/v1/organization'
const owner = () => db.connection('owner')
const ok = (r: any, status = 201) => {
  if (r.status() !== status) throw new Error(`${r.status()} ${JSON.stringify(r.body())}`)
  return r.body().data
}
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

async function member(
  client: any,
  admin: Session,
  roleCode: string,
  grants: [string[], string, string?][]
) {
  const m = await memberWithRoles(client, admin, [])
  let n = 0
  for (const [permissions, scopeType, scopeId] of grants) {
    const role = await createRole(client, admin, `${roleCode}_${n++}`, permissions)
    ok(
      await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
        roleId: role.id,
        scopeType,
        ...(scopeId ? { scopeId } : {}),
      }),
      200
    )
  }
  return { api: as(client, m.session), session: m.session }
}

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const entity = async (c: string, taxId: string) =>
    ok(
      await api.post(`${ORG}/legal-entities`, {
        code: c,
        legalName: `Entidade ${c}, Lda.`,
        taxId,
        countryCode: 'AO',
        functionalCurrency: 'AOA',
      })
    )
  const le = await entity('LEA', '5000000961')
  const le2 = await entity('LEB', '5000000962')
  const I = '/api/v1/inventory'
  const un = ok(
    await api.post(`${I}/settings/uoms`, { code: 'UN', name: 'Unidade', category: 'UNIT' })
  )
  const pump = ok(
    await api.post(`${I}/products`, {
      sku: 'BOMBA',
      name: 'Bomba de água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
    })
  )
  const wh = ok(
    await api.post(`${I}/warehouses`, {
      code: 'ARM-A',
      name: 'Armazém A',
      legalEntityId: le.id,
      warehouseType: 'MAIN',
    })
  )
  const approver = await member(client, s, 'aprova', [
    [
      [
        'procurement.suppliers.approve',
        'procurement.orders.approve',
        'procurement.invoices.approve',
      ],
      'TENANT',
    ],
  ])
  const supplier = async (n: number) => {
    let sup = ok(
      await api.post(`${P}/suppliers`, {
        supplierType: 'GOODS',
        currency: 'AOA',
        paymentTermsDays: 30,
        partner: {
          code: `FORN-${n}`,
          name: `Fornecedor ${n}`,
          partnerType: 'ORGANIZATION',
          taxId: `541700006${n}`,
          countryCode: 'AO',
        },
      })
    )
    sup = ok(
      await api.post(`${P}/suppliers/${sup.id}/submit`, {
        expectedVersion: sup.version,
        items: [],
      }),
      200
    )
    return ok(
      await approver.api.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
      200
    )
  }
  const s1 = await supplier(1)
  const s2 = await supplier(2)
  for (const [t, c] of [
    ['PURCHASE_ORDER', 'OC'],
    ['PURCHASE_RECEIPT', 'RE'],
    ['PURCHASE_INVOICE', 'FF'],
    ['PURCHASE_RETURN', 'DV'],
    ['RFQ', 'PC'],
  ])
    ok(
      await api.post('/api/v1/document-series', {
        legalEntityId: le.id,
        documentType: t,
        code: c,
        prefix: `${c}-`,
      })
    )
  const buyer = await member(client, s, 'compra', [
    [
      [
        'procurement.orders.manage',
        'procurement.receipts.manage',
        'procurement.invoices.manage',
        'procurement.returns.manage',
        'procurement.rfqs.manage',
      ],
      'LEGAL_ENTITY',
      le.id,
    ],
  ])
  const evaluator = await member(client, s, 'avalia', [
    [['procurement.evaluations.manage'], 'TENANT'],
  ])
  const reader = await member(client, s, 'leitor', [
    [['procurement.evaluations.read'], 'LEGAL_ENTITY', le.id],
  ])
  const other = await member(client, s, 'outra', [
    [['procurement.evaluations.read', 'procurement.evaluations.manage'], 'LEGAL_ENTITY', le2.id],
  ])
  const B = buyer.api
  /** Ordem emitida de bombas a 100 e recepção confirmada (aceite e recusada). */
  const received = async (
    sup: any,
    o: { orderDate: string; expectedDate: string; accepted: string; rejected?: string }
  ) => {
    let po = ok(
      await B.post(O, {
        legalEntityId: le.id,
        supplierId: sup.id,
        warehouseId: wh.id,
        orderDate: o.orderDate,
        expectedDate: o.expectedDate,
        lines: [{ productId: pump.id, quantity: '10', unitPrice: '100' }],
      })
    )
    po = ok(await B.post(`${O}/${po.id}/submit`, { expectedVersion: po.version }), 200)
    po = ok(await approver.api.post(`${O}/${po.id}/approve`, { expectedVersion: po.version }), 200)
    po = ok(await B.post(`${O}/${po.id}/issue`, { expectedVersion: po.version }), 200)
    let rc = ok(
      await B.post(R, {
        orderId: po.id,
        lines: [
          {
            orderLineId: po.lines[0].id,
            quantity: o.accepted,
            ...(o.rejected ? { rejectedQuantity: o.rejected, rejectReason: 'Partida' } : {}),
          },
        ],
      })
    )
    rc = ok(await B.post(`${R}/${rc.id}/confirm`, { expectedVersion: rc.version }), 200)
    return { po, rc }
  }
  const invoice = async (po: any, n: string, quantity: string, price: string) => {
    const inv = ok(
      await B.post(F, {
        orderId: po.id,
        invoiceNumber: n,
        invoiceDate: day(0),
        declaredTotal: String(Number(quantity) * Number(price)),
        lines: [{ orderLineId: po.lines[0].id, quantity, unitPrice: price }],
      })
    )
    return ok(await B.post(`${F}/${inv.id}/validate`, { expectedVersion: inv.version }), 200)
  }
  return {
    api,
    le,
    s1,
    s2,
    buyer,
    approver,
    evaluator,
    reader,
    other,
    B,
    received,
    invoice,
    upload: (sess: Session, id: string) =>
      client
        .post('/api/v1/attachments')
        .header('cookie', sess.cookie)
        .header('x-xsrf-token', sess.xsrf)
        .header('x-tenant-id', sess.tenantId)
        .field('subjectType', 'purchase_return')
        .field('subjectId', id)
        .file('file', PNG, { filename: 'prova.png', contentType: 'image/png' }),
  }
}

test.group('Compras | avaliação de fornecedores (9.11)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('indicadores das provas (qualidade, prazo, conformidade, custo), pesos, mapa, publicação imutável e âmbito', async ({
    client,
    assert,
  }) => {
    const x = await setup(client)
    const B = x.B
    // Fornecedor 1: ordem A atrasada (prevista há 5 dias), 8 aceites e 2 recusadas; 2 das aceites devolvidas.
    const a = await x.received(x.s1, {
      orderDate: day(-10),
      expectedDate: day(-5),
      accepted: '8',
      rejected: '2',
    })
    let d = ok(
      await B.post(`${P}/returns`, {
        receiptId: a.rc.id,
        reasonCode: 'QUALITY',
        description: 'Duas bombas com fuga',
        remedy: 'CREDIT',
        lines: [{ receiptLineId: a.rc.lines[0].id, quantity: '2' }],
      })
    )
    ok(await x.upload(x.buyer.session, d.id))
    d = ok(await B.post(`${P}/returns/${d.id}/confirm`, { expectedVersion: d.version }), 200)
    // Ordem B a tempo, 5 aceites.
    const b = await x.received(x.s1, { orderDate: day(0), expectedDate: day(5), accepted: '5' })
    // Facturas: B conforme; A a 110 (acima da ordem) só com excepção autorizada.
    assert.equal((await x.invoice(b.po, 'S1-1', '5', '100')).status, 'VALIDATED')
    let ia = await x.invoice(a.po, 'S1-2', '6', '110')
    assert.equal(ia.status, 'PENDING_EXCEPTION')
    ia = ok(
      await x.approver.api.post(`${F}/${ia.id}/approve`, {
        expectedVersion: ia.version,
        reason: 'Preço actualizado pelo fornecedor',
      }),
      200
    )
    assert.equal(ia.status, 'VALIDATED')
    // Fornecedor 2: tudo a tempo e conforme.
    const c = await x.received(x.s2, { orderDate: day(0), expectedDate: day(3), accepted: '4' })
    assert.equal((await x.invoice(c.po, 'S2-1', '4', '100')).status, 'VALIDATED')
    // Pedido de cotação aberto com as duas propostas: fornecedor 1 a 120, fornecedor 2 a 100.
    let r = ok(
      await B.post(Q, {
        legalEntityId: x.le.id,
        title: 'Bombas',
        closesAt: at(48),
        lines: [{ description: 'Bomba centrífuga', quantity: '10' }],
      })
    )
    r = ok(await B.post(`${Q}/${r.id}/invitations`, { supplierIds: [x.s1.id, x.s2.id] }), 200)
    r = ok(await B.post(`${Q}/${r.id}/issue`, { expectedVersion: r.version }), 200)
    for (const [sup, price] of [
      [x.s1, '120'],
      [x.s2, '100'],
    ])
      r = ok(
        await B.post(`${Q}/${r.id}/quotes`, {
          supplierId: sup.id,
          validUntil: day(30),
          lines: [{ rfqLineId: r.lines[0].id, quantity: '10', unitPrice: price }],
        })
      )
    r = ok(await B.post(`${Q}/${r.id}/open`, { expectedVersion: r.version }), 200)

    // Mapa: fornecedor 2 à frente (A); fornecedor 1 com C.
    const period = `from=${day(-30)}&to=${day(0)}`
    let map = ok(await x.reader.api.get(`${EV}/ranking?${period}`), 200)
    assert.deepEqual(map.weights, { quality: 30, delivery: 30, compliance: 20, cost: 20 })
    assert.deepEqual(
      map.items.map((i: any) => [i.supplier.code, i.score, i.rating]),
      [
        ['FORN-2', '100.00', 'A'],
        ['FORN-1', '65.67', 'C'],
      ]
    )
    // Qualidade (60 + 100) ÷ 2; prazo 1 de 2; conformidade 1 de 2; custo 100 ÷ 120.
    assert.deepEqual(map.items[1].indicators, {
      quality: { score: '80.00', evidence: 2 },
      delivery: { score: '50.00', evidence: 2 },
      compliance: { score: '50.00', evidence: 2 },
      cost: { score: '83.33', evidence: 1 },
    })
    assert.deepInclude(map.summary, { A: 1, C: 1 })
    // Provas do fornecedor 1.
    const det = ok(await x.reader.api.get(`${EV}/suppliers/${x.s1.id}?${period}`), 200)
    assert.lengthOf(det.evidence.receipts, 2)
    assert.deepEqual(
      det.evidence.receipts.map((e: any) => [e.late, e.rejectedLines, e.returnedLines]).sort(),
      [
        [false, 0, 0],
        [true, 1, 1],
      ]
    )
    assert.deepEqual(det.evidence.invoices.map((i: any) => [i.invoiceNumber, i.excepted]).sort(), [
      ['S1-1', false],
      ['S1-2', true],
    ])
    assert.deepEqual(det.evidence.rfqs[0], { ...det.evidence.rfqs[0], lines: 1, cheapest: 0 })
    assert.isFalse(det.can.publish)
    // Pesos: só com procurement.settings; têm de somar 100; o mapa usa os novos.
    assert.equal((await x.reader.api.put(`${EV}/weights`, { quality: 50 })).status(), 403)
    assert.include(
      details(
        await x.api.put(`${EV}/weights`, { quality: 50, delivery: 50, compliance: 10, cost: 0 })
      ),
      'SUM'
    )
    ok(await x.api.put(`${EV}/weights`, { quality: 50, delivery: 50, compliance: 0, cost: 0 }), 200)
    map = ok(await x.reader.api.get(`${EV}/ranking?${period}`), 200)
    assert.equal(map.items.find((i: any) => i.supplier.code === 'FORN-1').score, '65.00')
    ok(
      await x.api.put(`${EV}/weights`, { quality: 30, delivery: 30, compliance: 20, cost: 20 }),
      200
    )
    // Publicar: só no âmbito da empresa; período válido; com provas.
    const body = { from: day(-30), to: day(0), comment: 'Atrasos e uma devolução por qualidade.' }
    assert.equal(code(await x.reader.api.post(`${EV}/suppliers/${x.s1.id}`, body)), 'OUT_OF_SCOPE')
    assert.equal(code(await x.other.api.post(`${EV}/suppliers/${x.s1.id}`, body)), 'OUT_OF_SCOPE')
    assert.include(
      details(
        await x.evaluator.api.post(`${EV}/suppliers/${x.s1.id}`, { from: day(0), to: day(-1) })
      ),
      'BEFORE_FROM'
    )
    assert.equal(
      code(
        await x.evaluator.api.post(`${EV}/suppliers/${x.s1.id}`, {
          from: '2020-01-01',
          to: '2020-12-31',
        })
      ),
      'NO_EVIDENCE'
    )
    const e1 = ok(await x.evaluator.api.post(`${EV}/suppliers/${x.s1.id}`, body))
    assert.deepInclude(e1, { score: '65.67', rating: 'C', superseded: false })
    assert.deepEqual(e1.weights, { quality: 30, delivery: 30, compliance: 20, cost: 20 })
    assert.equal(e1.indicators.cost.score, '83.33')
    // Reavaliação do mesmo período: a anterior fica no histórico, substituída.
    const e2 = ok(
      await x.evaluator.api.post(`${EV}/suppliers/${x.s1.id}`, { ...body, comment: 'Revista.' })
    )
    const hist = ok(await x.evaluator.api.get(`${EV}/suppliers/${x.s1.id}?${period}`), 200)
    assert.isTrue(hist.can.publish)
    assert.deepEqual(
      hist.history.map((h: any) => [h.id, h.superseded]),
      [
        [e2.id, false],
        [e1.id, true],
      ]
    )
    // Na base não se altera nem se apaga; a substituída não volta.
    await assert.rejects(() =>
      owner().rawQuery(`update supplier_evaluations set score = 99 where id = ?`, [e2.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update supplier_evaluations set superseded_by_id = null where id = ?`, [
        e1.id,
      ])
    )
    await assert.rejects(() => owner().rawQuery(`delete from supplier_evaluations`))
    // A ficha do fornecedor mostra a avaliação em vigor; o mapa também.
    const sup = ok(await x.api.get(`${P}/suppliers/${x.s1.id}`), 200)
    assert.deepInclude(sup.evaluation, { id: e2.id, rating: 'C', score: '65.67' })
    map = ok(await x.reader.api.get(`${EV}/ranking?${period}`), 200)
    assert.equal(map.items.find((i: any) => i.supplier.code === 'FORN-1').latest.rating, 'C')
    assert.equal(ok(await x.reader.api.get(`${EV}/${e2.id}`), 200).comment, 'Revista.')
    // Outra entidade não vê provas desta: o mapa fica vazio e o fornecedor sem nota.
    assert.lengthOf(ok(await x.other.api.get(`${EV}/ranking?${period}`), 200).items, 0)
    const far = ok(await x.other.api.get(`${EV}/suppliers/${x.s1.id}?${period}`), 200)
    assert.isNull(far.score)
    assert.equal(far.indicators.quality.evidence, 0)
    const actions = (
      await owner().rawQuery(
        `select distinct action from audit_events where action like 'supplier_evaluation.%' order by action`
      )
    ).rows.map((x2: any) => x2.action)
    assert.deepEqual(actions, [
      'supplier_evaluation.published',
      'supplier_evaluation.weights_updated',
    ])
  })
})
