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

async function setup(client: any) {
  const { tenant, admin } = await tenantWithAdmin()
  const s = await signIn(client, admin.email, tenant.id)
  const api = as(client, s)
  const le = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEA',
      legalName: 'Entidade A, Lda.',
      taxId: '5000000911',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const le2 = ok(
    await api.post(`${ORG}/legal-entities`, {
      code: 'LEB',
      legalName: 'Entidade B, Lda.',
      taxId: '5000000912',
      countryCode: 'AO',
      functionalCurrency: 'AOA',
    })
  )
  const dept = ok(
    await api.post(`${ORG}/departments`, {
      code: 'MANUT',
      name: 'Manutenção',
      legalEntityId: le.id,
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
  // Fornecedores: três homologados (pelo aprovador, nunca por quem pede) e um em rascunho.
  const approver = await member(client, s, 'homolog', [
    [['procurement.suppliers.approve', 'procurement.requisitions.approve'], 'TENANT'],
  ])
  const supplier = async (n: number, approve = true) => {
    let sup = ok(
      await api.post(`${P}/suppliers`, {
        supplierType: 'GOODS',
        currency: 'AOA',
        partner: {
          code: `FORN-${n}`,
          name: `Fornecedor ${n}, Lda.`,
          partnerType: 'ORGANIZATION',
          taxId: `541700001${n}`,
          countryCode: 'AO',
        },
      })
    )
    if (!approve) return sup
    sup = ok(
      await api.post(`${P}/suppliers/${sup.id}/submit`, {
        expectedVersion: sup.version,
        items: [],
      }),
      200
    )
    return ok(
      await approver.post(`${P}/suppliers/${sup.id}/approve`, { expectedVersion: sup.version }),
      200
    )
  }
  const s1 = await supplier(1)
  const s2 = await supplier(2)
  const s3 = await supplier(3)
  const draft = await supplier(4, false)
  // Requisição aprovada com uma linha da bomba (10 UN).
  ok(
    await api.post('/api/v1/document-series', {
      legalEntityId: le.id,
      documentType: 'PURCHASE_REQUISITION',
      code: 'RC',
      prefix: 'RC-',
    })
  )
  let req = ok(
    await api.post(`${P}/requisitions`, {
      departmentId: dept.id,
      neededBy: day(20),
      purpose: 'Reparação da estação de bombagem',
      lines: [{ productId: pump.id, quantity: '10', estimatedUnitPrice: '1000' }],
    })
  )
  req = ok(
    await api.post(`${P}/requisitions/${req.id}/submit`, { expectedVersion: req.version }),
    200
  )
  req = ok(
    await approver.post(`${P}/requisitions/${req.id}/approve`, { expectedVersion: req.version }),
    200
  )
  const buyer = await member(client, s, 'cotacao', [
    [['procurement.rfqs.manage'], 'LEGAL_ENTITY', le.id],
  ])
  const viewer = await member(client, s, 'leitor', [
    [['procurement.rfqs.read'], 'LEGAL_ENTITY', le.id],
  ])
  const other = await member(client, s, 'outra', [
    [['procurement.rfqs.manage'], 'LEGAL_ENTITY', le2.id],
  ])
  const body = (extra: Record<string, unknown> = {}) => ({
    legalEntityId: le.id,
    title: 'Bombas e reparação',
    specifications: 'Bomba centrífuga 2 cv, garantia de 12 meses.',
    closesAt: at(48),
    deliveryTerms: 'Entrega no armazém de Viana',
    paymentTerms: '30 dias após factura',
    lines: [
      { requisitionLineId: req.lines[0].id },
      { description: 'Instalação e ensaio', quantity: '1', specifications: 'No local' },
    ],
    ...extra,
  })
  return { tenant, s, api, le, le2, un, pump, s1, s2, s3, draft, req, buyer, viewer, other, body }
}

test.group('Compras | pedidos de cotação (9.3)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('rascunho, convites homologados, emissão numerada, envelope fechado, versões, revisão, abertura e anulação', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    // Validações e âmbito.
    assert.include(details(await B.post(Q, o.body({ closesAt: at(-1) }))), 'PAST')
    assert.include(details(await B.post(Q, o.body({ lines: [] }))), 'REQUIRED')
    assert.equal(code(await o.other.post(Q, o.body())), 'OUT_OF_SCOPE')
    assert.equal(code(await o.viewer.post(Q, o.body())), 'OUT_OF_SCOPE')
    assert.include(
      details(
        await B.post(
          Q,
          o.body({ lines: [{ requisitionLineId: o.req.lines[0].id, quantity: '0' }] })
        )
      ),
      'INVALID'
    )
    let r = ok(await B.post(Q, o.body()))
    assert.deepInclude(r, {
      status: 'DRAFT',
      number: null,
      currency: 'AOA',
      sealed: true,
      revision: 0,
    })
    // A linha da requisição traz o produto, a unidade, a quantidade em aberto e a referência.
    assert.deepInclude(r.lines[0], { description: 'Bomba de água', quantity: '10.000000' })
    assert.equal(r.lines[0].uom.code, 'UN')
    assert.equal(r.lines[0].requisition.number, o.req.number)
    // Outra entidade não vê; o leitor da entidade vê.
    assert.equal((await o.other.get(`${Q}/${r.id}`)).status(), 404)
    assert.equal(ok(await o.viewer.get(`${Q}/${r.id}`), 200).can.edit, false)
    // Convites: só homologados.
    assert.include(
      details(await B.post(`${Q}/${r.id}/invitations`, { supplierIds: [o.s1.id, o.draft.id] })),
      'NOT_QUALIFIED'
    )
    r = ok(
      await B.post(`${Q}/${r.id}/invitations`, { supplierIds: [o.s1.id, o.s2.id, o.s3.id] }),
      200
    )
    assert.lengthOf(r.invitations, 3)
    const inv3 = r.invitations.find((i: any) => i.supplier.id === o.s3.id)
    r = ok(await B.delete(`${P}/rfq-invitations/${inv3.id}`), 200)
    assert.deepEqual(r.invitations.map((i: any) => i.supplier.code).sort(), ['FORN-1', 'FORN-2'])
    // Emissão: precisa de série.
    assert.equal(
      code(await B.post(`${Q}/${r.id}/issue`, { expectedVersion: r.version })),
      'NO_SERIES'
    )
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.le.id,
        documentType: 'RFQ',
        code: 'PC',
        prefix: 'PC-',
      })
    )
    assert.equal(
      (await B.post(`${Q}/${r.id}/issue`, { expectedVersion: r.version - 1 })).status(),
      409
    )
    r = ok(await B.post(`${Q}/${r.id}/issue`, { expectedVersion: r.version }), 200)
    assert.deepInclude(r, { status: 'OPEN', pricesHidden: true })
    assert.match(r.number, /^PC-0*1$/)
    // Emitido: não se edita nem se retira convidados; o número e a moeda não mudam nem por SQL.
    assert.equal(
      code(await B.put(`${Q}/${r.id}`, { ...o.body(), expectedVersion: r.version })),
      'INVALID_STATE'
    )
    const inv1 = r.invitations.find((i: any) => i.supplier.id === o.s1.id)
    const inv2 = r.invitations.find((i: any) => i.supplier.id === o.s2.id)
    assert.equal(code(await B.delete(`${P}/rfq-invitations/${inv1.id}`)), 'INVALID_STATE')
    await assert.rejects(() =>
      owner().rawQuery(`update rfqs set number = 'X' where id = ?`, [r.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update rfqs set currency = 'USD' where id = ?`, [r.id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update rfq_lines set description = 'Outra' where rfq_id = ?`, [r.id])
    )
    await assert.rejects(() => owner().rawQuery(`delete from rfqs where id = ?`, [r.id]))

    // Propostas: só de convidados; alternativas descritas; linhas do pedido.
    const lineA = r.lines[0].id
    const lineB = r.lines[1].id
    const quote = (extra: Record<string, unknown> = {}) => ({
      supplierId: o.s1.id,
      supplierReference: 'PROP-77',
      validUntil: day(30),
      deliveryDays: 10,
      paymentTermsDays: 30,
      lines: [
        { rfqLineId: lineA, quantity: '10', unitPrice: '1500.5', taxRate: '14' },
        {
          rfqLineId: lineA,
          alternativeNo: 1,
          description: 'Bomba 3 cv',
          quantity: '10',
          unitPrice: '1800',
        },
        { rfqLineId: lineB, quantity: '1', unitPrice: '25000' },
      ],
      ...extra,
    })
    assert.include(
      details(await B.post(`${Q}/${r.id}/quotes`, quote({ supplierId: o.s3.id }))),
      'NOT_INVITED'
    )
    assert.include(
      details(
        await B.post(
          `${Q}/${r.id}/quotes`,
          quote({ lines: [{ rfqLineId: lineA, alternativeNo: 1, quantity: '1', unitPrice: '1' }] })
        )
      ),
      'REQUIRED'
    )
    assert.include(
      details(
        await B.post(
          `${Q}/${r.id}/quotes`,
          quote({ lines: [{ rfqLineId: o.pump.id, quantity: '1', unitPrice: '1' }] })
        )
      ),
      'NOT_FOUND'
    )
    assert.include(
      details(await B.post(`${Q}/${r.id}/quotes`, quote({ validUntil: day(-1) }))),
      'INVALID'
    )
    assert.equal(code(await o.viewer.post(`${Q}/${r.id}/quotes`, quote())), 'OUT_OF_SCOPE')
    r = ok(await B.post(`${Q}/${r.id}/quotes`, quote()))
    // Envelope fechado: chegou, de quem e quando; nenhum valor (nem para quem registou, nem para o leitor).
    let q1 = r.quotes.find((q: any) => q.supplier.id === o.s1.id)
    assert.deepInclude(q1, {
      quoteVersion: 1,
      status: 'ACTIVE',
      totalAmount: null,
      currency: null,
      lines: [],
    })
    assert.isNull(ok(await o.viewer.get(`${Q}/${r.id}`), 200).quotes[0].totalAmount)
    assert.equal(r.invitations.find((i: any) => i.id === inv1.id).status, 'RESPONDED')
    // Nova versão do mesmo fornecedor: a anterior fica substituída (e imutável).
    r = ok(await B.post(`${Q}/${r.id}/quotes`, quote({ supplierReference: 'PROP-78' })))
    const mine = r.quotes.filter((q: any) => q.supplier.id === o.s1.id)
    assert.deepEqual(
      mine.map((q: any) => [q.quoteVersion, q.status]),
      [
        [2, 'ACTIVE'],
        [1, 'SUPERSEDED'],
      ]
    )
    await assert.rejects(() =>
      owner().rawQuery(`update rfq_quotes set total_amount = 1 where id = ?`, [mine[1].id])
    )
    await assert.rejects(() =>
      owner().rawQuery(`update rfq_quotes set status = 'ACTIVE' where id = ?`, [mine[1].id])
    )
    await assert.rejects(() => owner().rawQuery(`update rfq_quote_lines set unit_price = 1`))
    // Nem a auditoria nem o histórico guardam valores enquanto o envelope está fechado.
    const leaks = await owner().rawQuery(
      `select count(*)::int as n from audit_events where action = 'rfq.quote_received' and changes::text like '%total%'`
    )
    assert.equal(leaks.rows[0].n, 0)
    assert.notInclude(JSON.stringify(r.history), '1500')

    // Abertura antes do prazo só com todos os convidados respondidos ou declinados.
    assert.isFalse(r.can.open)
    assert.equal(
      code(await B.post(`${Q}/${r.id}/open`, { expectedVersion: r.version })),
      'EARLY_OPENING'
    )
    // Revisão com motivo: quantidade da linha; a proposta passa a desactualizada.
    assert.include(
      details(
        await B.post(`${Q}/${r.id}/amend`, {
          expectedVersion: r.version,
          lines: [{ lineId: lineA, quantity: '12' }],
        })
      ),
      'REQUIRED'
    )
    r = ok(
      await B.post(`${Q}/${r.id}/amend`, {
        expectedVersion: r.version,
        reason: 'Mais duas bombas de reserva',
        closesAt: at(72),
        lines: [{ lineId: lineA, quantity: '12' }],
      }),
      200
    )
    assert.equal(r.revision, 1)
    assert.equal(r.lines[0].quantity, '12.000000')
    assert.isTrue(r.quotes.find((q: any) => q.status === 'ACTIVE').outdated)
    // O fornecedor 2 declina (com motivo): agora pode abrir-se.
    assert.include(details(await B.post(`${P}/rfq-invitations/${inv2.id}/decline`, {})), 'REQUIRED')
    r = ok(await B.post(`${P}/rfq-invitations/${inv2.id}/decline`, { reason: 'Sem stock' }), 200)
    assert.equal(
      code(await B.post(`${Q}/${r.id}/quotes`, quote({ supplierId: o.s2.id }))),
      'DECLINED'
    )
    assert.isTrue(r.can.open)
    r = ok(await B.post(`${Q}/${r.id}/open`, { expectedVersion: r.version }), 200)
    assert.deepInclude(r, { status: 'CLOSED', pricesHidden: false })
    assert.isNotNull(r.openedAt)
    // Abertas: os valores aparecem, exactos (só as ofertas principais somam).
    q1 = r.quotes.find((q: any) => q.status === 'ACTIVE')
    assert.deepInclude(q1, {
      supplierReference: 'PROP-78',
      currency: 'AOA',
      totalNet: '40005.00',
      totalTax: '2100.70',
      totalAmount: '42105.70',
      deliveryDays: 10,
    })
    assert.deepEqual(
      q1.lines.map((l: any) => [l.lineNo, l.alternativeNo, l.netAmount]),
      [
        [1, 0, '15005.00'],
        [1, 1, '18000.00'],
        [2, 0, '25000.00'],
      ]
    )
    // Fechado: sem propostas novas nem revisões; anular exige motivo.
    assert.equal(code(await B.post(`${Q}/${r.id}/quotes`, quote())), 'INVALID_STATE')
    assert.equal(
      code(
        await B.post(`${Q}/${r.id}/amend`, {
          expectedVersion: r.version,
          reason: 'x',
          closesAt: at(5),
        })
      ),
      'INVALID_STATE'
    )
    assert.include(
      details(await B.post(`${Q}/${r.id}/cancel`, { expectedVersion: r.version })),
      'REQUIRED'
    )
    r = ok(
      await B.post(`${Q}/${r.id}/cancel`, {
        expectedVersion: r.version,
        reason: 'Orçamento retirado',
      }),
      200
    )
    assert.deepInclude(r, { status: 'CANCELLED', cancelReason: 'Orçamento retirado' })
    await assert.rejects(() => owner().rawQuery(`update rfqs set title = 'x' where id = ?`, [r.id]))
    assert.deepEqual(r.history.map((e: any) => e.kind).reverse(), [
      'CREATED',
      'INVITED',
      'UNINVITED',
      'ISSUED',
      'QUOTE_RECEIVED',
      'QUOTE_RECEIVED',
      'AMENDED',
      'DECLINED',
      'OPENED',
      'CANCELLED',
    ])
    await assert.rejects(() => owner().rawQuery(`delete from rfq_events`))
    // A requisição não ficou afectada (a afectação é na ordem de compra, 9.5).
    const req = ok(await o.api.get(`${P}/requisitions/${o.req.id}`), 200)
    assert.equal(req.lines[0].orderedQuantity, '0.000000')
    // Auditoria das acções.
    const actions = await owner().rawQuery(
      `select distinct action from audit_events where action like 'rfq.%' order by action`
    )
    assert.deepEqual(
      actions.rows.map((x: any) => x.action),
      [
        'rfq.amended',
        'rfq.cancelled',
        'rfq.created',
        'rfq.invited',
        'rfq.issued',
        'rfq.opened',
        'rfq.quote_received',
      ]
    )
  })

  test('prazo: proposta tardia recusada, abertura depois do prazo, retirada de proposta e envelope aberto', async ({
    client,
    assert,
  }) => {
    const o = await setup(client)
    const B = o.buyer
    ok(
      await o.api.post('/api/v1/document-series', {
        legalEntityId: o.le.id,
        documentType: 'RFQ',
        code: 'PC',
        prefix: 'PC-',
      })
    )
    // Sem envelope: os valores vêem-se logo.
    let r = ok(
      await B.post(
        Q,
        o.body({
          sealed: false,
          supplierIds: [o.s1.id, o.s2.id],
          lines: [{ productId: o.pump.id, quantity: '3' }],
        })
      )
    )
    r = ok(await B.post(`${Q}/${r.id}/issue`, { expectedVersion: r.version }), 200)
    const line = r.lines[0].id
    const quote = (supplierId: string, price: string) => ({
      supplierId,
      validUntil: day(15),
      lines: [{ rfqLineId: line, quantity: '3', unitPrice: price }],
    })
    r = ok(await B.post(`${Q}/${r.id}/quotes`, quote(o.s1.id, '100')))
    assert.equal(r.quotes[0].totalAmount, '300.00')
    // Retirar (com motivo) devolve o convite a "convidado".
    const qid = r.quotes[0].id
    assert.include(details(await B.post(`${P}/rfq-quotes/${qid}/withdraw`, {})), 'REQUIRED')
    r = ok(await B.post(`${P}/rfq-quotes/${qid}/withdraw`, { reason: 'Preço errado' }), 200)
    assert.deepInclude(r.quotes[0], { status: 'WITHDRAWN', withdrawReason: 'Preço errado' })
    assert.equal(r.invitations.find((i: any) => i.supplier.id === o.s1.id).status, 'INVITED')
    assert.equal(
      code(await B.post(`${P}/rfq-quotes/${qid}/withdraw`, { reason: 'x' })),
      'INVALID_STATE'
    )
    r = ok(await B.post(`${Q}/${r.id}/quotes`, quote(o.s1.id, '90')))
    // Passado o prazo: propostas recusadas, abertura permitida mesmo sem todos.
    await owner().rawQuery(`update rfqs set closes_at = now() - interval '1 minute' where id = ?`, [
      r.id,
    ])
    assert.equal(code(await B.post(`${Q}/${r.id}/quotes`, quote(o.s2.id, '80'))), 'QUOTE_LATE')
    r = ok(await o.api.get(`${Q}/${r.id}`), 200)
    assert.isTrue(r.can.open)
    assert.isFalse(r.can.quote)
    r = ok(await B.post(`${Q}/${r.id}/open`, { expectedVersion: r.version }), 200)
    assert.equal(r.status, 'CLOSED')
    // Emissão com o prazo já passado é recusada; a lista filtra por estado.
    let d = ok(await B.post(Q, o.body({ supplierIds: [o.s1.id] })))
    await owner().rawQuery(`update rfqs set closes_at = now() - interval '1 minute' where id = ?`, [
      d.id,
    ])
    d = ok(await B.get(`${Q}/${d.id}`), 200)
    assert.include(
      details(await B.post(`${Q}/${d.id}/issue`, { expectedVersion: d.version })),
      'PAST'
    )
    const list = ok(await B.get(`${Q}?status=CLOSED`), 200)
    assert.deepEqual(
      list.map((x: any) => [x.status, x.invited, x.quotes]),
      [['CLOSED', 2, 1]]
    )
    assert.lengthOf(ok(await o.other.get(Q), 200), 0)
  })
})
