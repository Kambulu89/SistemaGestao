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
const Q = `${P}/rfqs`
const A = `${P}/rfq-awards`
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
  return as(client, m.session)
}

/** Pedido fechado com duas linhas e três propostas (AOA, USD com alternativa, AOA só da linha 1). */
async function setup(client: any, opts: { s3Currency?: string } = {}) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000921',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const le2 = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEB',
      legalName: 'Entidade B, Lda.',
      taxId: '5000000922',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const un = ok(
    await api.post('/api/v1/inventory/settings/uoms', {
      code: 'UN',
      name: 'Unidade',
      category: 'UNIT',
    })
  )
  const pump = ok(
    await api.post('/api/v1/inventory/products', {
      sku: 'BOMBA',
      name: 'Bomba de água',
      productType: 'STOCKABLE',
      baseUomId: un.id,
    })
  )
  const homolog = await member(client, s, 'homolog', [
    [['procurement.suppliers.approve'], 'TENANT'],
  ])
  const sups: any[] = []
  for (const n of [1, 2, 3]) {
    let sup = ok(
      await api.post(`${P}/suppliers`, {
        supplierType: 'GOODS',
        currency: 'AOA',
        partner: {
          code: `FORN-${n}`,
          name: `Fornecedor ${n}`,
          partnerType: 'ORGANIZATION',
          taxId: `541700002${n}`,
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
    sups.push(
      ok(
        await homolog.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
        200
      )
    )
  }
  ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'RFQ',
      code: 'PC',
      prefix: 'PC-',
    })
  )
  ok(
    await api.post('/api/v1/exchange-rates', {
      fromCurrency: 'USD',
      toCurrency: 'AOA',
      rate: '900',
      validOn: day(-1),
    })
  )
  // Comprador que também aprova (para a segregação), aprovador, aprovador de outra entidade, leitor.
  const buyer = await member(client, s, 'compra', [
    [['procurement.rfqs.manage', 'procurement.rfqs.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const approver = await member(client, s, 'aprova', [
    [['procurement.rfqs.approve'], 'LEGAL_ENTITY', le.id],
  ])
  const otherApprover = await member(client, s, 'aprova_b', [
    [['procurement.rfqs.approve'], 'LEGAL_ENTITY', le2.id],
  ])
  const viewer = await member(client, s, 'leitor', [
    [['procurement.rfqs.read'], 'LEGAL_ENTITY', le.id],
  ])
  let r = ok(
    await buyer.post(Q, {
      legalEntityId: le.id,
      title: 'Bombas e instalação',
      closesAt: at(48),
      supplierIds: sups.map((x) => x.id),
      lines: [
        { productId: pump.id, quantity: '10' },
        { description: 'Instalação e ensaio', quantity: '1' },
      ],
    })
  )
  r = ok(await buyer.post(`${Q}/${r.id}/issue`, { expectedVersion: r.version }), 200)
  const [L1, L2] = r.lines.map((l: any) => l.id)
  const quote = (supplierId: string, extra: Record<string, unknown>) =>
    buyer.post(`${Q}/${r.id}/quotes`, { supplierId, validUntil: day(30), ...extra })
  ok(
    await quote(sups[0].id, {
      deliveryDays: 10,
      paymentTermsDays: 30,
      lines: [
        { rfqLineId: L1, quantity: '10', unitPrice: '1000', taxRate: '14' },
        { rfqLineId: L2, quantity: '1', unitPrice: '50000' },
      ],
    })
  )
  ok(
    await quote(sups[1].id, {
      currency: 'USD',
      deliveryDays: 20,
      paymentTermsDays: 30,
      lines: [
        { rfqLineId: L1, quantity: '10', unitPrice: '1', taxRate: '14' },
        {
          rfqLineId: L1,
          alternativeNo: 1,
          description: 'Modelo económico',
          quantity: '10',
          unitPrice: '0.9',
          taxRate: '14',
        },
        { rfqLineId: L2, quantity: '1', unitPrice: '60' },
      ],
    })
  )
  ok(
    await quote(sups[2].id, {
      currency: opts.s3Currency ?? 'AOA',
      deliveryDays: 5,
      paymentTermsDays: 60,
      lines: [{ rfqLineId: L1, quantity: '10', unitPrice: '950', taxRate: '14' }],
    })
  )
  r = ok(await buyer.get(`${Q}/${r.id}`), 200)
  r = ok(await buyer.post(`${Q}/${r.id}/open`, { expectedVersion: r.version }), 200)
  const ql = (supplierId: string, lineId: string, alt = 0) =>
    r.quotes
      .find((x: any) => x.supplier.id === supplierId && x.status === 'ACTIVE')
      .lines.find((x: any) => x.rfqLineId === lineId && x.alternativeNo === alt).id as string
  return { api, le, sups, buyer, approver, otherApprover, viewer, r, L1, L2, ql }
}

const QUALITY = (o: any) => ({ [o.sups[0].id]: 80, [o.sups[1].id]: 70, [o.sups[2].id]: 90 })

test.group('Compras | comparação e adjudicação (9.4)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('mapa comparativo normalizado, pontuação ponderada, adjudicação por linha e fornecedor, aprovação segregada', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    const id = o.r.id
    // Pesos: inteiros que somam 100.
    assert.include(
      details(
        await B.post(`${Q}/${id}/comparison`, {
          weights: { price: 50, delivery: 20, quality: 20, payment: 0 },
        })
      ),
      'WEIGHTS_SUM'
    )
    assert.include(
      details(await B.post(`${Q}/${id}/comparison`, { weights: { price: 1.5 } })),
      'INVALID'
    )
    const cmp = ok(await B.post(`${Q}/${id}/comparison`, { quality: QUALITY(o) }), 200)
    assert.deepInclude(cmp, { baseCurrency: 'AOA', rateDate: day(0) })
    assert.deepEqual(cmp.rates, [{ currency: 'USD', rate: '900.0000000000' }])
    assert.deepEqual(cmp.weights, { price: 60, delivery: 20, quality: 20, payment: 0 })
    // Linha 1: preços normalizados (USD × 900), pontuações e a melhor (FORN-3: mais barato a seguir à alternativa,
    // entrega mais curta e melhor qualidade).
    const line1 = cmp.lines[0]
    const byKey = Object.fromEntries(
      line1.offers.map((x: any) => [`${x.supplier.code}/${x.alternativeNo}`, x])
    )
    assert.equal(byKey['FORN-2/0'].unitPriceBase, '900.000000')
    assert.equal(byKey['FORN-2/1'].unitPriceBase, '810.000000')
    assert.equal(byKey['FORN-2/0'].totalBase, '10260.00')
    assert.deepEqual(byKey['FORN-3/0'].score, {
      price: 85.26,
      delivery: 100,
      quality: 90,
      payment: 100,
      total: 89.16,
      best: true,
    })
    assert.deepInclude(byKey['FORN-1/0'].score, { price: 81, delivery: 54.55, total: 75.51 })
    assert.deepInclude(byKey['FORN-2/1'].score, { price: 100, delivery: 28.57, total: 79.71 })
    assert.deepEqual(
      line1.offers.map((x: any) => `${x.supplier.code}/${x.alternativeNo}`),
      ['FORN-3/0', 'FORN-2/1', 'FORN-1/0', 'FORN-2/0']
    )
    assert.equal(cmp.lines[1].offers[0].supplier.code, 'FORN-1')
    assert.isTrue(cmp.lines[1].offers[0].score.best)
    const f2 = cmp.suppliers.find((x: any) => x.supplier.code === 'FORN-2')
    assert.deepInclude(f2, { currency: 'USD', linesQuoted: 2, totalBase: '64260.00', bestLines: 0 })
    // Outros pesos mudam a ordem: só preço → a alternativa económica ganha.
    const cheap = ok(
      await B.post(`${Q}/${id}/comparison`, {
        weights: { price: 100, delivery: 0, quality: 0, payment: 0 },
      }),
      200
    )
    assert.equal(cheap.lines[0].offers[0].supplier.code, 'FORN-2')
    assert.equal(cheap.lines[0].offers[0].alternativeNo, 1)
    // Outra entidade não vê; o leitor vê o mapa mas não adjudica.
    assert.equal((await o.otherApprover.post(`${Q}/${id}/comparison`, {})).status(), 404)
    ok(await o.viewer.post(`${Q}/${id}/comparison`, {}), 200)

    // Adjudicação: validações.
    const base = {
      quality: QUALITY(o),
      justification: 'Melhor pontuação na linha 1; instalação pelo fornecedor da bomba.',
      lines: [
        { quoteLineId: o.ql(o.sups[2].id, o.L1), quantity: '10' },
        { quoteLineId: o.ql(o.sups[1].id, o.L2), quantity: '1' },
      ],
    }
    assert.equal(code(await o.viewer.post(`${Q}/${id}/awards`, base)), 'OUT_OF_SCOPE')
    assert.include(
      details(await B.post(`${Q}/${id}/awards`, { ...base, quality: {} })),
      'QUALITY_REQUIRED'
    )
    assert.include(
      details(await B.post(`${Q}/${id}/awards`, { ...base, justification: 'curta' })),
      'REQUIRED'
    )
    assert.include(details(await B.post(`${Q}/${id}/awards`, base)), 'NOT_BEST')
    assert.include(
      details(
        await B.post(`${Q}/${id}/awards`, {
          ...base,
          lines: [{ quoteLineId: o.ql(o.sups[2].id, o.L1), quantity: '11' }],
        })
      ),
      'OVER_OFFER'
    )
    assert.include(
      details(
        await B.post(`${Q}/${id}/awards`, {
          ...base,
          lines: [
            { quoteLineId: o.ql(o.sups[2].id, o.L1), quantity: '6' },
            { quoteLineId: o.ql(o.sups[0].id, o.L1), quantity: '5', reason: 'Dividir o risco' },
          ],
        })
      ),
      'OVER_REQUESTED'
    )
    assert.include(
      details(
        await B.post(`${Q}/${id}/awards`, {
          ...base,
          lines: [{ quoteLineId: o.L1, quantity: '1' }],
        })
      ),
      'NOT_FOUND'
    )
    const body = {
      ...base,
      lines: [
        { quoteLineId: o.ql(o.sups[2].id, o.L1), quantity: '10' },
        {
          quoteLineId: o.ql(o.sups[1].id, o.L2),
          quantity: '1',
          reason: 'Instalador certificado pelo fabricante',
        },
      ],
    }
    let a = ok(await B.post(`${Q}/${id}/awards`, body))
    // Fotografia: 10 × 950 + 14% e 60 USD × 900; totais na moeda de base.
    assert.deepInclude(a, {
      status: 'DRAFT',
      baseCurrency: 'AOA',
      totalNetBase: '63500.00',
      totalBase: '64830.00',
    })
    const l2 = a.lines.find((x: any) => x.supplier.code === 'FORN-2')
    assert.deepInclude(l2, {
      currency: 'USD',
      rate: '900.0000000000',
      unitPriceBase: '54000.000000',
      netBase: '54000.00',
      best: false,
      reason: 'Instalador certificado pelo fabricante',
    })
    assert.deepEqual(
      a.bySupplier.map((x: any) => [x.supplier.code, x.totalBase]),
      [
        ['FORN-3', '10830.00'],
        ['FORN-2', '54000.00'],
      ]
    )
    assert.equal(code(await B.post(`${Q}/${id}/awards`, body)), 'AWARD_EXISTS')
    // Editar o rascunho com versão; outros pesos.
    assert.equal((await B.put(`${A}/${a.id}`, { ...body, expectedVersion: 99 })).status(), 409)
    a = ok(
      await B.put(`${A}/${a.id}`, {
        ...body,
        weights: { price: 50, delivery: 20, quality: 20, payment: 10 },
        expectedVersion: a.version,
      }),
      200
    )
    assert.deepEqual(a.weights, { price: 50, delivery: 20, quality: 20, payment: 10 })
    // Submeter; quem submete não decide; aprovador de outra entidade não vê.
    a = ok(await B.post(`${A}/${a.id}/submit`, { expectedVersion: a.version }), 200)
    assert.equal(a.status, 'PENDING_APPROVAL')
    assert.equal(a.can.decideBlockedBy, 'SELF_APPROVAL')
    assert.equal(
      code(await B.post(`${A}/${a.id}/approve`, { expectedVersion: a.version })),
      'SELF_APPROVAL'
    )
    assert.equal((await o.otherApprover.get(`${A}/${a.id}`)).status(), 404)
    assert.equal(
      code(await B.put(`${A}/${a.id}`, { ...body, expectedVersion: a.version })),
      'INVALID_STATE'
    )
    // Fixa na base depois de submetida.
    await assert.rejects(() =>
      owner().rawQuery(`update rfq_award_lines set quantity = 1 where award_id = ?`, [a.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update rfq_awards set price_weight = 60, payment_weight = 0 where id = ?`, [
        a.id,
      ])
    )
    await assert.rejects(() => owner().rawQuery(`delete from rfq_awards where id = ?`, [a.id]))
    // O pedido não se anula com a adjudicação em aprovação.
    const rr = ok(await B.get(`${Q}/${id}`), 200)
    assert.equal(
      code(await B.post(`${Q}/${id}/cancel`, { expectedVersion: rr.version, reason: 'x' })),
      'AWARD_IN_PROGRESS'
    )
    // O aprovador vê-o nos pendentes e recusa (motivo obrigatório).
    const pending = ok(await o.approver.get(`${Q}?pendingAward=true`), 200)
    assert.deepEqual(
      pending.map((x: any) => x.id),
      [id]
    )
    assert.include(
      details(await o.approver.post(`${A}/${a.id}/reject`, { expectedVersion: a.version })),
      'REQUIRED'
    )
    a = ok(
      await o.approver.post(`${A}/${a.id}/reject`, {
        expectedVersion: a.version,
        reason: 'Fazer a instalação com o fornecedor local',
      }),
      200
    )
    assert.deepInclude(a, {
      status: 'REJECTED',
      decisionReason: 'Fazer a instalação com o fornecedor local',
    })
    await assert.rejects(() =>
      owner().rawQuery(`update rfq_awards set justification = 'x' where id = ?`, [a.id])
    )
    // Nova adjudicação (o pedido continua fechado): só as melhores; aprovada por outra pessoa → pedido adjudicado.
    let rfq = ok(await B.get(`${Q}/${id}`), 200)
    assert.isTrue(rfq.can.award)
    let b = ok(
      await B.post(`${Q}/${id}/awards`, {
        ...base,
        lines: [
          { quoteLineId: o.ql(o.sups[2].id, o.L1), quantity: '10' },
          { quoteLineId: o.ql(o.sups[0].id, o.L2), quantity: '1' },
        ],
      })
    )
    assert.equal(b.totalBase, '60830.00')
    b = ok(await B.post(`${A}/${b.id}/submit`, { expectedVersion: b.version }), 200)
    b = ok(await o.approver.post(`${A}/${b.id}/approve`, { expectedVersion: b.version }), 200)
    assert.deepInclude(b, { status: 'APPROVED' })
    assert.isNotNull(b.decidedBy)
    rfq = ok(await B.get(`${Q}/${id}`), 200)
    assert.equal(rfq.status, 'AWARDED')
    assert.isFalse(rfq.can.award)
    assert.isFalse(rfq.can.cancel)
    assert.deepEqual(
      rfq.awards.map((x: any) => x.status),
      ['APPROVED', 'REJECTED']
    )
    await assert.rejects(() =>
      owner().rawQuery(
        `update rfq_awards set status = 'CANCELLED', cancel_reason = 'x' where id = ?`,
        [b.id]
      )
    )
    // Segregação também na base: quem decide não é quem submeteu.
    await assert.rejects(() =>
      owner().rawQuery(`update rfq_awards set decided_by = submitted_by where id = ?`, [b.id])
    )
    const kinds = rfq.history.map((e: any) => e.kind)
    for (const k of ['AWARD_DRAFTED', 'AWARD_SUBMITTED', 'AWARD_REJECTED', 'AWARDED'])
      assert.include(kinds, k)
    const actions = await owner().rawQuery(
      `select distinct action from audit_events where action like 'rfq_award.%' order by action`
    )
    assert.deepEqual(
      actions.rows.map((x: any) => x.action),
      [
        'rfq_award.approved',
        'rfq_award.created',
        'rfq_award.rejected',
        'rfq_award.submitted',
        'rfq_award.updated',
      ]
    )
  })

  test('sem câmbio a oferta não é pontuada nem adjudicável; proposta caducada não se aprova; anulação', async ({
    client,
    assert,
  }) => {
    const o = await setup(client, { s3Currency: 'EUR' })
    const B = o.buyer
    const id = o.r.id
    const cmp = ok(
      await B.post(`${Q}/${id}/comparison`, {
        weights: { price: 100, delivery: 0, quality: 0, payment: 0 },
      }),
      200
    )
    assert.deepInclude(cmp.rates, { currency: 'EUR', rate: null })
    const f3 = cmp.lines[0].offers.find((x: any) => x.supplier.code === 'FORN-3')
    assert.isNull(f3.score)
    assert.isNull(f3.unitPriceBase)
    const priceOnly = { price: 100, delivery: 0, quality: 0, payment: 0 }
    assert.include(
      details(
        await B.post(`${Q}/${id}/awards`, {
          weights: priceOnly,
          justification: 'Apenas o preço conta nesta compra.',
          lines: [{ quoteLineId: o.ql(o.sups[2].id, o.L1), quantity: '10', reason: 'x' }],
        })
      ),
      'NO_RATE'
    )
    // Adjudica a alternativa económica (a melhor só pelo preço) e submete.
    let a = ok(
      await B.post(`${Q}/${id}/awards`, {
        weights: priceOnly,
        justification: 'Apenas o preço conta nesta compra.',
        lines: [{ quoteLineId: o.ql(o.sups[1].id, o.L1, 1), quantity: '10' }],
      })
    )
    a = ok(await B.post(`${A}/${a.id}/submit`, { expectedVersion: a.version }), 200)
    // A proposta caduca entretanto (simulado na base): não se aprova.
    await owner().rawQuery(`alter table rfq_quotes disable trigger rfq_quotes_fixed`)
    await owner().rawQuery(`update rfq_quotes set valid_until = ? where supplier_id = ?`, [
      day(-1),
      o.sups[1].id,
    ])
    await owner().rawQuery(`alter table rfq_quotes enable trigger rfq_quotes_fixed`)
    assert.equal(
      code(await o.approver.post(`${A}/${a.id}/approve`, { expectedVersion: a.version })),
      'QUOTE_EXPIRED'
    )
    // Anular (motivo) liberta o pedido para outra adjudicação ou para ser anulado.
    assert.include(
      details(await B.post(`${A}/${a.id}/cancel`, { expectedVersion: a.version })),
      'REQUIRED'
    )
    a = ok(
      await B.post(`${A}/${a.id}/cancel`, {
        expectedVersion: a.version,
        reason: 'Propostas caducadas',
      }),
      200
    )
    assert.equal(a.status, 'CANCELLED')
    const rfq = ok(await B.get(`${Q}/${id}`), 200)
    assert.isTrue(rfq.can.award)
    ok(
      await B.post(`${Q}/${id}/cancel`, {
        expectedVersion: rfq.version,
        reason: 'Repetir a consulta',
      }),
      200
    )
    // Anulado: já não há comparação.
    assert.equal(code(await B.post(`${Q}/${id}/comparison`, {})), 'INVALID_STATE')
  })
})
